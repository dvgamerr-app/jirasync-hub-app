import Dexie, { type Table } from "dexie";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";

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
  name: string;        // display name
  instanceUrl: string; // e.g. "https://acme.atlassian.net" or "acme"
  email: string;
  apiToken: string;
}

/** Backward-compat alias used by older code */
export type JiraSettings = JiraAccount;

const JIRA_ACCOUNTS_KEY = "jira-accounts";
const JIRA_SETTINGS_KEY_LEGACY = "jira-settings";

export function getJiraAccounts(): JiraAccount[] {
  try {
    const raw = localStorage.getItem(JIRA_ACCOUNTS_KEY);
    if (raw) return (JSON.parse(raw) as JiraAccount[]) ?? [];

    // Migrate from legacy single-settings key
    const legacy = localStorage.getItem(JIRA_SETTINGS_KEY_LEGACY);
    if (legacy) {
      const old = JSON.parse(legacy);
      if (old?.instanceUrl && old?.email && old?.apiToken) {
        const account: JiraAccount = {
          id: crypto.randomUUID(),
          name: getJiraBaseUrl(old).replace("https://", "").replace(".atlassian.net", ""),
          instanceUrl: old.instanceUrl,
          email: old.email,
          apiToken: old.apiToken,
        };
        saveJiraAccounts([account]);
        localStorage.removeItem(JIRA_SETTINGS_KEY_LEGACY);
        return [account];
      }
    }
    return [];
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

export function removeJiraAccount(id: string): void {
  saveJiraAccounts(getJiraAccounts().filter((a) => a.id !== id));
  // Clean up DB data for this account
  const orgId = `org-${id}`;
  db.organizations.delete(orgId).catch(() => {});
  db.projects.where("orgId").equals(orgId).delete().catch(() => {});
}

// Backward-compat helpers
export function getJiraSettings(): JiraAccount | null {
  return getJiraAccounts()[0] ?? null;
}

export function saveJiraSettings(s: Omit<JiraAccount, "id" | "name">): void {
  const existing = getJiraAccounts();
  const account: JiraAccount = {
    id: existing[0]?.id ?? crypto.randomUUID(),
    name: existing[0]?.name ?? getJiraBaseUrl(s as JiraAccount).replace("https://", "").replace(".atlassian.net", ""),
    ...s,
  };
  saveJiraAccounts([account, ...existing.slice(1)]);
}

export function clearJiraSettings(): void {
  localStorage.removeItem(JIRA_ACCOUNTS_KEY);
  localStorage.removeItem(JIRA_SETTINGS_KEY_LEGACY);
}

export function getJiraBaseUrl(account: Pick<JiraAccount, "instanceUrl">): string {
  const url = account.instanceUrl.trim();
  if (url.startsWith("http")) return url.replace(/\/$/, "");
  return `https://${url}.atlassian.net`;
}

