import { db, getJiraSettings } from "./jira-db";
import { fetchJiraOrganization, fetchJiraProjects, fetchJiraIssues } from "./jira-api";
import type { Task } from "@/types/jira";

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
  const settings = getJiraSettings();
  if (!settings) return;

  isSyncing = true;
  notify("syncing");

  try {
    // 1. Fetch org
    const org = await fetchJiraOrganization();
    await db.organizations.put(org);

    // 2. Fetch projects
    const projects = await fetchJiraProjects();

    // 3. For each project, fetch all issues
    for (const project of projects) {
      const { tasks, statuses } = await fetchJiraIssues(project.jiraProjectKey);
      project.availableStatuses = statuses;
      await db.projects.put(project);

      // Merge: preserve local dirty changes
      for (const task of tasks) {
        const existing = await db.tasks.get(task.id);
        if (existing && existing.isDirty) {
          // Keep local edits, update non-edited fields
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

    // 4. Update sync meta
    await db.syncMeta.put({
      id: "last-sync",
      lastSyncedAt: new Date().toISOString(),
      nextSyncAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    notify("success", `Synced ${projects.length} projects`);
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
  const settings = getJiraSettings();
  if (!settings) return;

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
