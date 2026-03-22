import { db, getJiraAccounts } from "./jira-db";
import { fetchAssignedJiraData, fetchJiraOrganization } from "./jira-api";
import type { Task, WorkLog } from "@/types/jira";
import { getOrganizationId } from "@/lib/jira-ids";

let syncInterval: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;
let syncPending = false;

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Sync failed";
}

function mergeRemoteTaskWithLocalState(remoteTask: Task, localTask?: Task): Task {
  if (!localTask?.isDirty) {
    return remoteTask;
  }

  return {
    ...remoteTask,
    type: localTask.type,
    severity: localTask.severity,
    storyLevel: localTask.storyLevel,
    mandays: localTask.mandays,
    note: localTask.note,
    refUrl: localTask.refUrl,
    status: localTask.status ?? remoteTask.status,
    isDirty: true,
    isSynced: false,
  };
}

async function replaceTaskWorklogs(taskId: string, freshLogs: WorkLog[]): Promise<void> {
  const existingWorkLogs = await db.workLogs.where("taskId").equals(taskId).toArray();
  const jiraSourcedIds = existingWorkLogs
    .filter((workLog) => Boolean(workLog.jiraWorklogId))
    .map((workLog) => workLog.id);

  if (jiraSourcedIds.length > 0) {
    await db.workLogs.bulkDelete(jiraSourcedIds);
  }

  if (freshLogs.length > 0) {
    await db.workLogs.bulkPut(freshLogs);
  }
}

async function removeStaleProjectsForAccount(
  accountId: string,
  visibleProjectIds: Set<string>,
): Promise<void> {
  const orgId = getOrganizationId(accountId);
  const existingProjects = await db.projects.where("orgId").equals(orgId).toArray();
  const staleProjectIds = existingProjects
    .map((project) => project.id)
    .filter((projectId) => !visibleProjectIds.has(projectId));

  if (staleProjectIds.length > 0) {
    await db.projects.bulkDelete(staleProjectIds);
  }
}

export async function syncNow(): Promise<void> {
  if (isSyncing) {
    syncPending = true;
    return;
  }
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

      // 2. Fetch only projects that contain issues for the configured Jira user
      const { projects, tasks, worklogsByTaskId } = await fetchAssignedJiraData(account);
      const visibleProjectIds = new Set(projects.map((project) => project.id));

      await removeStaleProjectsForAccount(account.id, visibleProjectIds);

      if (projects.length > 0) {
        totalProjects += projects.length;
        await db.projects.bulkPut(projects);
      }

      // 3. Merge only tasks that belong to the configured Jira user
      for (const task of tasks) {
        const existing = await db.tasks.get(task.id);
        await db.tasks.put(mergeRemoteTaskWithLocalState(task, existing));

        // Sync work logs: replace Jira-sourced logs, keep locally-created ones
        const freshLogs = worklogsByTaskId[task.id] ?? [];
        await replaceTaskWorklogs(task.id, freshLogs);
      }
    }

    // 4. Update sync meta
    await db.syncMeta.put({
      id: "last-sync",
      lastSyncedAt: new Date().toISOString(),
      nextSyncAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    notify(
      "success",
      `Synced ${totalProjects} project${totalProjects !== 1 ? "s" : ""} across ${accounts.length} account${accounts.length !== 1 ? "s" : ""}`,
    );
  } catch (err: unknown) {
    console.error("Sync failed:", err);
    notify("error", getErrorMessage(err));
    throw err;
  } finally {
    isSyncing = false;
    if (syncPending) {
      syncPending = false;
      syncNow().catch(() => {});
    }
  }
}

export function startBackgroundSync() {
  stopBackgroundSync();
  const accounts = getJiraAccounts();
  if (accounts.length === 0) return;

  // Sync immediately, then every hour
  syncNow().catch(() => {});
  syncInterval = setInterval(
    () => {
      syncNow().catch(() => {});
    },
    60 * 60 * 1000,
  );
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
