import Dexie, { type Table } from "dexie";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";
import { getOrganizationId, getTaskIdPrefix } from "@/lib/jira-ids";

export interface SyncMeta {
  id: string;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
}

class JiraDatabase extends Dexie {
  organizations!: Table<Organization, string>;
  projects!: Table<Project, string>;
  tasks!: Table<Task, string>;
  workLogs!: Table<WorkLog, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super("jira-task-manager");
    this.version(1).stores({
      organizations: "id, name",
      projects: "id, orgId, jiraProjectKey",
      tasks: "id, projectId, jiraTaskId, status, isDirty",
      workLogs: "id, taskId, logDate",
      syncMeta: "id",
    });
  }
}

export const db = new JiraDatabase();

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
  try {
    const raw = localStorage.getItem(JIRA_ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as JiraAccount[]) : [];
  } catch {
    return [];
  }
}

export function saveJiraAccounts(accounts: JiraAccount[]): void {
  localStorage.setItem(JIRA_ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function addJiraAccount(account: Omit<JiraAccount, "id">): JiraAccount {
  const newAccount: JiraAccount = { ...account, id: crypto.randomUUID() };
  saveJiraAccounts([...getJiraAccounts(), newAccount]);
  return newAccount;
}

export function updateJiraAccount(account: JiraAccount): void {
  saveJiraAccounts(getJiraAccounts().map((a) => (a.id === account.id ? account : a)));
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
}

export function getJiraBaseUrl(account: Pick<JiraAccount, "instanceUrl">): string {
  const url = account.instanceUrl.trim();
  if (url.startsWith("http")) return url.replace(/\/$/, "");
  return `https://${url}.atlassian.net`;
}

function deriveAccountName(account: Pick<JiraAccount, "instanceUrl">): string {
  return getJiraBaseUrl(account).replace("https://", "").replace(".atlassian.net", "");
}

async function cleanupAccountData(accountId: string): Promise<void> {
  const orgId = getOrganizationId(accountId);
  const taskIdPrefix = getTaskIdPrefix(accountId);

  try {
    await db.transaction("rw", db.organizations, db.projects, db.tasks, db.workLogs, async () => {
      await db.organizations.delete(orgId);
      await db.projects.where("orgId").equals(orgId).delete();
      await db.tasks.where("id").startsWith(taskIdPrefix).delete();
      await db.workLogs.where("taskId").startsWith(taskIdPrefix).delete();
    });
  } catch (error) {
    console.error(`Failed to clean local Jira data for account ${accountId}:`, error);
  }
}
