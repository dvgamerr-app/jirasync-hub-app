import { db, getJiraAccounts } from "./jira-db";
import { fetchJiraOrganization, fetchJiraProjects, fetchJiraIssues } from "./jira-api";

let syncInterval: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;

export type SyncStatus = "idle" | "syncing" | "success" | "error";
type SyncListener = (status: SyncStatus, message?: string) => void;

const listeners: Set<SyncListener> = new Set();

export function onSyncStatus(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(status: SyncStatus, message?: string) {
  listeners.forEach((l) => l(status, message));
}

export async function syncNow(): Promise<void> {
  if (isSyncing) return;
  const accounts = getJiraAccounts();
  if (accounts.length === 0) return;

  isSyncing = true;
  notify("syncing");

  let totalProjects = 0;

  try {
    for (const account of accounts) {
      // 1. Fetch org info
      const org = await fetchJiraOrganization(account);
      await db.organizations.put(org);

      // 2. Fetch projects
      const projects = await fetchJiraProjects(account);

      // 3. For each project, fetch issues assigned to current user — skip projects with none
      for (const project of projects) {
        const { tasks, statuses } = await fetchJiraIssues(account, project.jiraProjectKey);
        if (tasks.length === 0) continue;

        totalProjects++;
        project.availableStatuses = statuses;
        await db.projects.put(project);

        // Merge: preserve local dirty changes
        for (const task of tasks) {
          const existing = await db.tasks.get(task.id);
          if (existing && existing.isDirty) {
            await db.tasks.put({
              ...task,
              type: existing.type,
              severity: existing.severity,
              storyLevel: existing.storyLevel,
              mandays: existing.mandays,
              note: existing.note,
              refUrl: existing.refUrl,
              isDirty: true,
              status: existing.status ?? task.status,
            });
          } else {
            await db.tasks.put(task);
          }
        }
      }
    }

    // 4. Update sync meta
    await db.syncMeta.put({
      id: "last-sync",
      lastSyncedAt: new Date().toISOString(),
      nextSyncAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    notify("success", `Synced ${totalProjects} project${totalProjects !== 1 ? "s" : ""} across ${accounts.length} account${accounts.length !== 1 ? "s" : ""}`);
  } catch (err: any) {
    console.error("Sync failed:", err);
    notify("error", err.message ?? "Sync failed");
    throw err;
  } finally {
    isSyncing = false;
  }
}

export function startBackgroundSync() {
  stopBackgroundSync();
  const accounts = getJiraAccounts();
  if (accounts.length === 0) return;

  // Sync immediately, then every hour
  syncNow().catch(() => {});
  syncInterval = setInterval(() => {
    syncNow().catch(() => {});
  }, 60 * 60 * 1000);
}

export function stopBackgroundSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

export async function getLastSyncTime(): Promise<string | null> {
  const meta = await db.syncMeta.get("last-sync");
  return meta?.lastSyncedAt ?? null;
}

