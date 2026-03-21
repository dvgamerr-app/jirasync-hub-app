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

// Jira settings stored in localStorage
export interface JiraSettings {
  instanceUrl: string; // e.g. "https://acme.atlassian.net" or "acme" (subdomain only)
  email: string;
  apiToken: string;
}

const JIRA_SETTINGS_KEY = "jira-settings";

export function getJiraSettings(): JiraSettings | null {
  try {
    const raw = localStorage.getItem(JIRA_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.instanceUrl && parsed.email && parsed.apiToken) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveJiraSettings(settings: JiraSettings): void {
  localStorage.setItem(JIRA_SETTINGS_KEY, JSON.stringify(settings));
}

export function clearJiraSettings(): void {
  localStorage.removeItem(JIRA_SETTINGS_KEY);
}

export function getJiraBaseUrl(settings: JiraSettings): string {
  const url = settings.instanceUrl.trim();
  if (url.startsWith("http")) return url.replace(/\/$/, "");
  return `https://${url}.atlassian.net`;
}
