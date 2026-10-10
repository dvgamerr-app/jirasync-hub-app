import Dexie, { type Table, type Transaction } from "dexie";
import { invoke } from "@tauri-apps/api/core";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";
import { getOrganizationId, getTaskIdPrefix } from "@/lib/jira-ids";

export interface SyncMeta {
  id: string;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  /** Per-account rows only (id `account:<accountId>`): when the last complete (non-incremental) pull finished. */
  lastFullSyncAt?: string | null;
}

// ── Schema versions ───────────────────────────────────────────────────────────────────────────
// IndexedDB holds the user's only copy of unpushed edits, so schema changes must be additive and
// versioned. Rules:
//   • Never edit or delete an existing entry — installed apps replay the list in order to upgrade.
//   • A schema change (new store/index) or a data reshaping is a NEW entry with the next number;
//     list the full `stores` for that version and put any data fix in `upgrade`.
//   • `upgrade` runs inside one transaction: if it throws, nothing is applied and the old data is
//     untouched. Write it so it can safely see records from every earlier version.
//   • Never call `db.delete()` / `Dexie.delete()` to "fix" an open failure (see ensureDatabaseReady).
type SchemaVersion = {
  version: number;
  stores: Record<string, string>;
  upgrade?: (tx: Transaction) => void | Promise<void>;
};

const SCHEMA_VERSIONS: SchemaVersion[] = [
  {
    version: 1,
    stores: {
      organizations: "id, name",
      projects: "id, orgId, jiraProjectKey",
      tasks: "id, projectId, jiraTaskId, status, isDirty",
      workLogs: "id, taskId, logDate",
      syncMeta: "id",
    },
  },
  {
    // The note became local-only. Before, editing it marked the task dirty (and pushed it into
    // the Jira description). A task whose only unpushed change was its note now has nothing to
    // push, so clear that stale "dirty" state — the note text itself is never touched.
    version: 2,
    stores: {
      organizations: "id, name",
      projects: "id, orgId, jiraProjectKey",
      tasks: "id, projectId, jiraTaskId, status, isDirty",
      workLogs: "id, taskId, logDate",
      syncMeta: "id",
    },
    upgrade: async (tx) => {
      const pendingWorkLogTaskIds = new Set<string>();
      await tx
        .table("workLogs")
        .toCollection()
        .each((workLog: WorkLog) => {
          const pendingDelete = workLog.syncStatus === "pending_delete";
          const pendingCreate =
            workLog.syncStatus === "pending_create" ||
            (workLog.jiraWorklogId == null && !pendingDelete);
          if (pendingCreate || pendingDelete) pendingWorkLogTaskIds.add(workLog.taskId);
        });

      await tx
        .table("tasks")
        .toCollection()
        .modify((task: Task) => {
          // dirtyFields undefined = legacy record that may hold other edits: leave it alone
          if (!task.isDirty || !Array.isArray(task.dirtyFields)) return;
          task.dirtyFields = task.dirtyFields.filter((field) => field !== "note");
          if (task.dirtyFields.length === 0 && !pendingWorkLogTaskIds.has(task.id)) {
            task.isDirty = false;
            task.isSynced = true;
          }
        });
    },
  },
];

class JiraDatabase extends Dexie {
  organizations!: Table<Organization, string>;
  projects!: Table<Project, string>;
  tasks!: Table<Task, string>;
  workLogs!: Table<WorkLog, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super("jira-task-manager");
    for (const { version, stores, upgrade } of SCHEMA_VERSIONS) {
      const schema = this.version(version).stores(stores);
      if (upgrade) schema.upgrade(upgrade);
    }
  }
}

export const db = new JiraDatabase();

/**
 * Opens the database and reports why it cannot be opened (e.g. data written by a newer app
 * version, or a failed upgrade) WITHOUT deleting anything, so the user's data survives for a
 * newer/fixed build. Resolves to null when the database is usable.
 */
export async function ensureDatabaseReady(): Promise<string | null> {
  try {
    await db.open();
    return null;
  } catch (error) {
    console.error("Could not open the local database:", error);
    return error instanceof Error ? error.message : String(error);
  }
}

// ── Jira Accounts (multiple instances) ────────────────────────────────────────
export interface JiraAccount {
  id: string;
  name: string; // display name
  instanceUrl: string; // e.g. "https://acme.atlassian.net" or "acme"
  email: string;
  apiToken: string;
}

/** @deprecated Use JiraAccount directly */
export type JiraSettings = JiraAccount;

const JIRA_ACCOUNTS_KEY = "jira-accounts";
const JIRA_SETTINGS_KEY_LEGACY = "jira-settings";

let _accountsCache: JiraAccount[] | null = null;

async function encryptAndPersist(accounts: JiraAccount[]): Promise<void> {
  try {
    const encrypted = await invoke<string>("encrypt_data", { plaintext: JSON.stringify(accounts) });
    localStorage.setItem(JIRA_ACCOUNTS_KEY, encrypted);
  } catch (e) {
    console.error("Failed to encrypt accounts:", e);
  }
}

// ── API tokens live in the OS credential store ──────────────────────────────────────────────
// Windows Credential Manager / macOS Keychain, via the store_secret/get_secret/delete_secret
// commands. The account list in localStorage then carries an empty `apiToken`. Where no store
// is available (Linux, or the command fails) the token stays in the encrypted localStorage blob
// exactly as before — a token is only ever removed from that blob after it was written to the
// credential store AND read back identically.

/** Writes the token to the credential store and verifies it by reading it back. */
async function storeTokenInKeychain(account: JiraAccount): Promise<boolean> {
  try {
    await invoke("store_secret", { account: account.id, secret: account.apiToken });
    const stored = await invoke<string | null>("get_secret", { account: account.id });
    return stored === account.apiToken;
  } catch {
    return false;
  }
}

async function readTokenFromKeychain(accountId: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("get_secret", { account: accountId })) ?? null;
  } catch {
    return null;
  }
}

async function deleteTokenFromKeychain(accountId: string): Promise<void> {
  try {
    await invoke("delete_secret", { account: accountId });
  } catch {
    // no credential store, or nothing stored: nothing to clean up
  }
}

// Saves are fire-and-forget from synchronous callers; chaining keeps them in call order so an
// older snapshot can never overwrite a newer one.
let persistQueue: Promise<void> = Promise.resolve();

function persistAccounts(accounts: JiraAccount[]): Promise<void> {
  const snapshot = accounts.map((account) => ({ ...account }));
  persistQueue = persistQueue.then(async () => {
    const toStore: JiraAccount[] = [];
    for (const account of snapshot) {
      const inKeychain = account.apiToken !== "" && (await storeTokenInKeychain(account));
      toStore.push(inKeychain ? { ...account, apiToken: "" } : account);
    }
    await encryptAndPersist(toStore);
  });
  return persistQueue;
}

/** Fills in tokens that were moved to the credential store. Returns true if any token still sat in the blob. */
async function hydrateTokens(accounts: JiraAccount[]): Promise<boolean> {
  let hasLegacyToken = false;
  for (const account of accounts) {
    if (account.apiToken) {
      hasLegacyToken = true;
      continue;
    }
    account.apiToken = (await readTokenFromKeychain(account.id)) ?? "";
  }
  return hasLegacyToken;
}

export async function initializeAccounts(): Promise<void> {
  const raw = localStorage.getItem(JIRA_ACCOUNTS_KEY);
  if (!raw) {
    _accountsCache = [];
    return;
  }
  try {
    const decrypted = await invoke<string>("decrypt_data", { ciphertext: raw });
    _accountsCache = JSON.parse(decrypted) as JiraAccount[];
  } catch {
    // migrate from plain-text format
    try {
      _accountsCache = JSON.parse(raw) as JiraAccount[];
      void persistAccounts(_accountsCache);
    } catch {
      _accountsCache = [];
    }
  }

  // Move tokens that are still stored in the blob (older versions) into the credential store.
  if (await hydrateTokens(_accountsCache)) void persistAccounts(_accountsCache);
}

export function migrateLegacyJiraSettings(): void {
  if (localStorage.getItem(JIRA_ACCOUNTS_KEY)) return;
  const legacy = localStorage.getItem(JIRA_SETTINGS_KEY_LEGACY);
  if (!legacy) return;
  try {
    const old = JSON.parse(legacy) as Record<string, unknown>;
    if (old?.instanceUrl && old?.email && old?.apiToken) {
      const account: JiraAccount = {
        id: crypto.randomUUID(),
        name: deriveAccountName(old as Pick<JiraAccount, "instanceUrl">),
        instanceUrl: old.instanceUrl as string,
        email: old.email as string,
        apiToken: old.apiToken as string,
      };
      saveJiraAccounts([account]);
      localStorage.removeItem(JIRA_SETTINGS_KEY_LEGACY);
    }
  } catch {
    // ignore malformed legacy data
  }
}

export function getJiraAccounts(): JiraAccount[] {
  return _accountsCache ?? [];
}

export function saveJiraAccounts(accounts: JiraAccount[]): void {
  _accountsCache = accounts;
  void persistAccounts(accounts);
}

export function addJiraAccount(account: Omit<JiraAccount, "id">): JiraAccount {
  const newAccount: JiraAccount = { ...account, id: crypto.randomUUID() };
  saveJiraAccounts([...getJiraAccounts(), newAccount]);
  return newAccount;
}

export function updateJiraAccount(account: JiraAccount): void {
  const previous = getJiraAccounts().find((a) => a.id === account.id);
  saveJiraAccounts(getJiraAccounts().map((a) => (a.id === account.id ? account : a)));
  // Pointing the account at another site/user makes the incremental-sync cursor meaningless.
  if (
    previous &&
    (previous.instanceUrl !== account.instanceUrl || previous.email !== account.email)
  ) {
    void db.syncMeta.delete(`account:${account.id}`).catch(() => {});
  }
}

export function reorderJiraAccounts(activeId: string, overId: string): JiraAccount[] {
  const accounts = getJiraAccounts();
  const fromIndex = accounts.findIndex((account) => account.id === activeId);
  const toIndex = accounts.findIndex((account) => account.id === overId);

  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return accounts;
  }

  const nextAccounts = [...accounts];
  const [movedAccount] = nextAccounts.splice(fromIndex, 1);
  nextAccounts.splice(toIndex, 0, movedAccount);
  saveJiraAccounts(nextAccounts);
  return nextAccounts;
}

export async function removeJiraAccount(id: string): Promise<void> {
  saveJiraAccounts(getJiraAccounts().filter((a) => a.id !== id));
  await deleteTokenFromKeychain(id);
  await cleanupAccountData(id);
}

// Backward-compat helpers
export function getJiraSettings(): JiraAccount | null {
  return getJiraAccounts()[0] ?? null;
}

export function saveJiraSettings(s: Omit<JiraAccount, "id" | "name">): void {
  const existing = getJiraAccounts();
  const account: JiraAccount = {
    id: existing[0]?.id ?? crypto.randomUUID(),
    name: existing[0]?.name ?? deriveAccountName(s as JiraAccount),
    ...s,
  };
  saveJiraAccounts([account, ...existing.slice(1)]);
}

export function clearJiraSettings(): void {
  localStorage.removeItem(JIRA_ACCOUNTS_KEY);
  localStorage.removeItem(JIRA_SETTINGS_KEY_LEGACY);
}

// ── Story Point Field Mapping ──────────────────────────────────────────────────
// Maps projectId → Jira custom field ID for story points.
// Stored in localStorage so it persists across app restarts without a DB migration.
const STORY_POINT_FIELDS_KEY = "jira-story-point-fields";

/** Returns the saved { projectId → fieldId } mapping. */
export function getStoryPointFieldMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORY_POINT_FIELDS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveStoryPointFieldMap(map: Record<string, string>): void {
  localStorage.setItem(STORY_POINT_FIELDS_KEY, JSON.stringify(map));
  // Story points are read while pulling issues; unchanged issues would keep the old field's value.
  requestFullSync();
}

// ── Full re-sync request ───────────────────────────────────────────────────────────────────────
// Incremental pulls skip unchanged issues. Anything that changes how issues are *read* (the story
// point field mapping) sets this flag so the next sync re-reads everything once.
const FULL_SYNC_REQUEST_KEY = "jira-force-full-sync";

export function requestFullSync(): void {
  try {
    localStorage.setItem(FULL_SYNC_REQUEST_KEY, "1");
  } catch {
    // storage unavailable: the daily full reconciliation still catches up
  }
}

export function isFullSyncRequested(): boolean {
  try {
    return localStorage.getItem(FULL_SYNC_REQUEST_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearFullSyncRequest(): void {
  try {
    localStorage.removeItem(FULL_SYNC_REQUEST_KEY);
  } catch {
    // ignore
  }
}

export function getJiraBaseUrl(account: Pick<JiraAccount, "instanceUrl">): string {
  const url = account.instanceUrl.trim();
  if (url.startsWith("http")) return url.replace(/\/+$/, "");
  // A bare host such as "acme.atlassian.net" must not get ".atlassian.net" appended again.
  if (url.includes(".")) return `https://${url.replace(/\/+$/, "")}`;
  return `https://${url}.atlassian.net`;
}

/**
 * Returns a user-facing problem with a Jira instance URL, or null when it is usable. The app can
 * only reach Atlassian Cloud sites (the HTTP capability is scoped to https://*.atlassian.net), so
 * anything else would fail later with a misleading "check credentials" message.
 */
export function validateJiraInstanceUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null; // emptiness is reported by the required-field check, not here

  if (/^http:\/\//i.test(value)) return "Use https:// — Jira Cloud does not accept plain http.";

  let host: string;
  try {
    const parsed = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`);
    host = parsed.hostname.toLowerCase();
    // Every REST call is appended to the entered URL, so a pasted board/issue URL would break them.
    if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
      return "Enter only the site address, e.g. https://your-company.atlassian.net (no path).";
    }
  } catch {
    return "This is not a valid URL or subdomain.";
  }

  if (!value.includes(".") && /^[a-z0-9-]+$/i.test(value)) return null; // bare subdomain: "acme"
  if (host.endsWith(".atlassian.net") && host.length > ".atlassian.net".length) return null;
  return "Only Atlassian Cloud sites (your-company.atlassian.net) are supported.";
}

function deriveAccountName(account: Pick<JiraAccount, "instanceUrl">): string {
  return getJiraBaseUrl(account).replace("https://", "").replace(".atlassian.net", "");
}

async function cleanupAccountData(accountId: string): Promise<void> {
  const orgId = getOrganizationId(accountId);
  const taskIdPrefix = getTaskIdPrefix(accountId);

  try {
    await db.transaction(
      "rw",
      db.organizations,
      db.projects,
      db.tasks,
      db.workLogs,
      db.syncMeta,
      async () => {
        await db.organizations.delete(orgId);
        await db.projects.where("orgId").equals(orgId).delete();
        await db.tasks.where("id").startsWith(taskIdPrefix).delete();
        await db.workLogs.where("taskId").startsWith(taskIdPrefix).delete();
        await db.syncMeta.delete(`account:${accountId}`);
      },
    );
  } catch (error) {
    console.error(`Failed to clean local Jira data for account ${accountId}:`, error);
  }
}
