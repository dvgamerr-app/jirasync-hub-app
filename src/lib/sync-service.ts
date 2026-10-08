import {
  clearFullSyncRequest,
  db,
  getJiraAccounts,
  isFullSyncRequested,
  type JiraAccount,
} from "./jira-db";
import { fetchAssignedJiraData, fetchJiraOrganization } from "./jira-api";
import type { DirtyField, Organization, Project, Task, WorkLog } from "@/types/jira";
import { getOrganizationId, getTaskIdPrefix } from "@/lib/jira-ids";
import { isPendingCreateWorkLog, isPendingDeleteWorkLog } from "@/lib/worklog-sync";
import { runExclusiveSync } from "@/lib/sync-lock";
import { getErrorMessage, mapWithConcurrency } from "@/lib/utils";

let syncInterval: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;
let syncPending = false;
let pendingFull = false;

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** An account is fully re-read at least this often, so deletions/reassignments are noticed. */
const FULL_RECONCILE_MS = 24 * 60 * 60 * 1000;
/** Incremental pulls look back this far past the last sync to absorb clock skew and indexing lag. */
const INCREMENTAL_OVERLAP_MINUTES = 15;

export type SyncStatus = "idle" | "syncing" | "success" | "error";
type SyncListener = (status: SyncStatus, message?: string) => void;

export interface SyncOptions {
  /** Re-read everything instead of only what changed since the last sync. */
  full?: boolean;
}

/** What a pull wrote to IndexedDB — handed to the store so it never has to guess or re-read. */
export interface SyncResult {
  /** True when no account needed a full re-read (only recently updated tickets were pulled). */
  incrementalOnly: boolean;
  organizations: Organization[];
  projects: Project[];
  tasks: Task[];
  /** Every worklog row now stored for `workLogTaskIds` (Jira-sourced and still-pending ones). */
  workLogs: WorkLog[];
  workLogTaskIds: string[];
  removedTaskIds: string[];
  removedProjectIds: string[];
  archivedTaskIds: string[];
  message: string;
  /** Accounts that failed (the rest still synced). */
  failures: string[];
}

type SyncResultListener = (result: SyncResult) => void;

const listeners: Set<SyncListener> = new Set();
const resultListeners: Set<SyncResultListener> = new Set();

export function onSyncStatus(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onSyncResult(listener: SyncResultListener): () => void {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
}

function notify(status: SyncStatus, message?: string) {
  for (const l of listeners) {
    try {
      l(status, message);
    } catch (e) {
      console.warn("SyncListener error:", e);
    }
  }
}

function emitResult(result: SyncResult) {
  for (const l of resultListeners) {
    try {
      l(result);
    } catch (e) {
      console.warn("SyncResultListener error:", e);
    }
  }
}

/** Turns a raw Jira API failure into something the user can act on. */
export function describeSyncError(error: unknown): string {
  const message = getErrorMessage(error);
  const status = message.match(/Jira API (\d{3})/)?.[1];
  if (status === "401") {
    return "Jira rejected the credentials (401). The API token may have expired or the email is wrong — update this account in Settings.";
  }
  if (status === "403") {
    return "Jira denied access (403). This account may not have permission for the request.";
  }
  if (status === "429") {
    return "Jira is rate limiting requests (429). Try again in a few minutes.";
  }
  return message;
}

export function mergeRemoteTaskWithLocalState(remoteTask: Task, localTask?: Task): Task {
  if (!localTask) return remoteTask;

  // The note only lives in this app (Jira's description is a different, rich-text field), so
  // a pull must never reset it.
  if (!localTask.isDirty) {
    return { ...remoteTask, note: localTask.note ?? remoteTask.note };
  }

  // Keep local values only for fields the user actually edited; everything else takes the fresh
  // Jira value, so a task that is dirty only because of a worklog still reflects Jira changes.
  // A dirty record without `dirtyFields` is a legacy one: keep all local values.
  const dirtyFields = localTask.dirtyFields;
  const keepsLocal = (field: DirtyField) =>
    dirtyFields === undefined || dirtyFields.includes(field);

  return {
    ...remoteTask,
    type: keepsLocal("type") ? localTask.type : remoteTask.type,
    severity: keepsLocal("severity") ? localTask.severity : remoteTask.severity,
    storyLevel: keepsLocal("storyLevel") ? localTask.storyLevel : remoteTask.storyLevel,
    mandays: keepsLocal("mandays") ? localTask.mandays : remoteTask.mandays,
    note: localTask.note,
    refUrl: localTask.refUrl,
    status: keepsLocal("status") ? (localTask.status ?? remoteTask.status) : remoteTask.status,
    dirtyFields,
    isDirty: true,
    isSynced: false,
  };
}

async function replaceTaskWorklogs(taskId: string, freshLogs: WorkLog[]): Promise<void> {
  const existingWorkLogs = await db.workLogs.where("taskId").equals(taskId).toArray();
  const pendingDeletedJiraIds = new Set(
    existingWorkLogs
      .filter(isPendingDeleteWorkLog)
      .map((workLog) => workLog.jiraWorklogId)
      .filter((jiraWorklogId): jiraWorklogId is string => Boolean(jiraWorklogId)),
  );

  const jiraSourcedIds = existingWorkLogs
    .filter((workLog) => Boolean(workLog.jiraWorklogId) && !isPendingDeleteWorkLog(workLog))
    .map((workLog) => workLog.id);

  const visibleFreshLogs = freshLogs.filter(
    (workLog) => !pendingDeletedJiraIds.has(workLog.jiraWorklogId ?? ""),
  );

  await db.transaction("rw", db.workLogs, async () => {
    if (jiraSourcedIds.length > 0) await db.workLogs.bulkDelete(jiraSourcedIds);
    if (visibleFreshLogs.length > 0) await db.workLogs.bulkPut(visibleFreshLogs);
  });
}

async function markStaleTasksAsArchived(
  visibleProjectIds: Set<string>,
  syncedTaskIds: Set<string>,
): Promise<string[]> {
  const localTasks = await db.tasks
    .where("projectId")
    .anyOf([...visibleProjectIds])
    .toArray();
  const staleIds = localTasks
    .filter((t) => !syncedTaskIds.has(t.id) && !t.isDirty)
    .map((t) => t.id);
  if (staleIds.length === 0) return [];
  await db.tasks.where("id").anyOf(staleIds).modify({ isArchived: true });
  return staleIds;
}

async function removeStaleProjectsForAccount(
  accountId: string,
  visibleProjectIds: Set<string>,
): Promise<{ taskIds: string[]; projectIds: string[] }> {
  const orgId = getOrganizationId(accountId);
  const existingProjects = await db.projects.where("orgId").equals(orgId).toArray();
  const staleProjectIds = existingProjects
    .map((project) => project.id)
    .filter((projectId) => !visibleProjectIds.has(projectId));

  if (staleProjectIds.length === 0) return { taskIds: [], projectIds: [] };

  const staleTasks = await db.tasks.where("projectId").anyOf(staleProjectIds).toArray();
  const staleTaskIds = staleTasks.map((task) => task.id);

  // Work the user has not pushed yet (edited tasks, pending worklogs) must survive: dropping the
  // project because Jira no longer lists it would silently destroy that work. Its project row is
  // kept too so the task stays reachable and can still be pushed.
  const staleWorkLogs =
    staleTaskIds.length > 0 ? await db.workLogs.where("taskId").anyOf(staleTaskIds).toArray() : [];
  const protectedTaskIds = new Set<string>([
    ...staleTasks.filter((task) => task.isDirty).map((task) => task.id),
    ...staleWorkLogs
      .filter((workLog) => isPendingCreateWorkLog(workLog) || isPendingDeleteWorkLog(workLog))
      .map((workLog) => workLog.taskId),
  ]);
  const protectedProjectIds = new Set(
    staleTasks.filter((task) => protectedTaskIds.has(task.id)).map((task) => task.projectId),
  );

  const removableTaskIds = staleTaskIds.filter((taskId) => !protectedTaskIds.has(taskId));
  const removableProjectIds = staleProjectIds.filter(
    (projectId) => !protectedProjectIds.has(projectId),
  );

  await db.transaction("rw", db.projects, db.tasks, db.workLogs, async () => {
    if (removableTaskIds.length > 0) {
      await db.workLogs.where("taskId").anyOf(removableTaskIds).delete();
      await db.tasks.bulkDelete(removableTaskIds);
    }
    if (removableProjectIds.length > 0) await db.projects.bulkDelete(removableProjectIds);
  });

  return { taskIds: removableTaskIds, projectIds: removableProjectIds };
}

const accountMetaId = (accountId: string) => `account:${accountId}`;

type SyncPlan = { mode: "full" } | { mode: "incremental"; updatedWithinMinutes: number };

/**
 * Full unless it is safe to pull only recent changes: the account must have completed a full
 * pull recently, still have its local data, and the clock must not have gone backwards.
 */
async function planAccountSync(account: JiraAccount, forceFull: boolean): Promise<SyncPlan> {
  if (forceFull) return { mode: "full" };

  const meta = await db.syncMeta.get(accountMetaId(account.id));
  const now = Date.now();
  const lastSynced = Date.parse(meta?.lastSyncedAt ?? "");
  const lastFull = Date.parse(meta?.lastFullSyncAt ?? "");
  if (!Number.isFinite(lastSynced) || !Number.isFinite(lastFull)) return { mode: "full" };
  if (lastSynced > now || now - lastFull > FULL_RECONCILE_MS) return { mode: "full" };

  const localTaskCount = await db.tasks.where("id").startsWith(getTaskIdPrefix(account.id)).count();
  if (localTaskCount === 0) return { mode: "full" };

  return {
    mode: "incremental",
    updatedWithinMinutes: (now - lastSynced) / 60_000 + INCREMENTAL_OVERLAP_MINUTES,
  };
}

type AccountSyncOutcome = Omit<SyncResult, "message" | "failures" | "incrementalOnly"> & {
  mode: SyncPlan["mode"];
};

/** Pulls one account from Jira into IndexedDB. */
async function syncAccount(account: JiraAccount, forceFull: boolean): Promise<AccountSyncOutcome> {
  const plan = await planAccountSync(account, forceFull);
  // Taken before the first request: anything edited while we pull is covered by the next window.
  const startedAt = new Date().toISOString();

  // 1. Fetch org info
  const org = await fetchJiraOrganization(account);
  await db.organizations.put(org);

  // 2. Fetch only projects that contain issues for the configured Jira user
  const { projects, tasks, worklogsByTaskId, worklogFetchFailedTaskIds } =
    await fetchAssignedJiraData(
      account,
      plan.mode === "incremental" ? { updatedWithinMinutes: plan.updatedWithinMinutes } : {},
    );
  const visibleProjectIds = new Set(projects.map((project) => project.id));

  // Absence from an incremental result means "unchanged", not "gone": only a full pull may
  // remove or archive anything.
  const removed =
    plan.mode === "full"
      ? await removeStaleProjectsForAccount(account.id, visibleProjectIds)
      : { taskIds: [], projectIds: [] };

  if (projects.length > 0) await db.projects.bulkPut(projects);

  // 3. Merge only tasks that belong to the configured Jira user
  const localTasks = await db.tasks.bulkGet(tasks.map((t) => t.id));
  const localMap = new Map(localTasks.filter(Boolean).map((t) => [t!.id, t!]));
  const mergedTasks = tasks.map((t) => mergeRemoteTaskWithLocalState(t, localMap.get(t.id)));
  await db.tasks.bulkPut(mergedTasks);
  const archivedTaskIds =
    plan.mode === "full"
      ? await markStaleTasksAsArchived(visibleProjectIds, new Set(tasks.map((t) => t.id)))
      : [];

  // Sync work logs: replace Jira-sourced logs, keep locally-created ones. A task whose full
  // worklog list could not be fetched keeps what it has — replacing it with nothing would wipe
  // the logged time until the next successful sync.
  const skipWorklogs = new Set(worklogFetchFailedTaskIds);
  const replacedTaskIds = tasks.map((task) => task.id).filter((id) => !skipWorklogs.has(id));
  await Promise.all(
    replacedTaskIds.map((taskId) => replaceTaskWorklogs(taskId, worklogsByTaskId[taskId] ?? [])),
  );
  const workLogs =
    replacedTaskIds.length > 0
      ? await db.workLogs.where("taskId").anyOf(replacedTaskIds).toArray()
      : [];

  const previousMeta = await db.syncMeta.get(accountMetaId(account.id));
  await db.syncMeta.put({
    id: accountMetaId(account.id),
    lastSyncedAt: startedAt,
    nextSyncAt: null,
    lastFullSyncAt: plan.mode === "full" ? startedAt : (previousMeta?.lastFullSyncAt ?? null),
  });

  return {
    mode: plan.mode,
    organizations: [org],
    projects,
    tasks: mergedTasks,
    workLogs,
    workLogTaskIds: replacedTaskIds,
    removedTaskIds: removed.taskIds,
    removedProjectIds: removed.projectIds,
    archivedTaskIds,
  };
}

function describeSuccess(outcomes: AccountSyncOutcome[], incrementalOnly: boolean): string {
  if (incrementalOnly) {
    const tasks = outcomes.reduce((sum, outcome) => sum + outcome.tasks.length, 0);
    return `Updated ${tasks} ticket${tasks !== 1 ? "s" : ""} from Jira`;
  }
  const projects = outcomes.reduce((sum, outcome) => sum + outcome.projects.length, 0);
  return `Synced ${projects} project${projects !== 1 ? "s" : ""} across ${outcomes.length} account${outcomes.length !== 1 ? "s" : ""}`;
}

/**
 * Pulls Jira into IndexedDB and returns what was written (also emitted to `onSyncResult`
 * listeners). Returns null when nothing ran (no accounts, or another sync was already running —
 * that one is queued to run again).
 */
export async function syncNow(options: SyncOptions = {}): Promise<SyncResult | null> {
  if (isSyncing) {
    syncPending = true;
    pendingFull ||= options.full === true;
    return null;
  }
  const accounts = getJiraAccounts();
  if (accounts.length === 0) return null;

  isSyncing = true;
  notify("syncing");
  const forceFull = options.full === true || isFullSyncRequested();

  try {
    // Wait for any in-flight push: pull and push touch the same rows (see sync-lock.ts).
    const { outcomes, failures } = await runExclusiveSync(async () => {
      const outcomes: AccountSyncOutcome[] = [];
      const failures: string[] = [];

      // One broken account (expired token, revoked access) must not stop the others syncing.
      // Accounts only touch their own rows, so they are pulled in parallel (order is preserved).
      const settled = await mapWithConcurrency(accounts, 3, async (account) => {
        try {
          return { outcome: await syncAccount(account, forceFull), failure: undefined };
        } catch (err: unknown) {
          console.error(`Sync failed for ${account.name || account.instanceUrl}:`, err);
          return {
            outcome: undefined,
            failure: `${account.name || account.instanceUrl}: ${describeSyncError(err)}`,
          };
        }
      });
      for (const result of settled) {
        if (result.outcome) outcomes.push(result.outcome);
        else if (result.failure) failures.push(result.failure);
      }

      if (outcomes.length > 0) {
        await db.syncMeta.put({
          id: "last-sync",
          lastSyncedAt: new Date().toISOString(),
          nextSyncAt: null,
        });
      }

      return { outcomes, failures };
    });

    if (outcomes.length === 0) {
      throw new Error(failures.join("\n"));
    }

    if (failures.length === 0 && forceFull) clearFullSyncRequest();

    const incrementalOnly = outcomes.every((outcome) => outcome.mode === "incremental");
    const result: SyncResult = {
      incrementalOnly,
      organizations: outcomes.flatMap((outcome) => outcome.organizations),
      projects: outcomes.flatMap((outcome) => outcome.projects),
      tasks: outcomes.flatMap((outcome) => outcome.tasks),
      workLogs: outcomes.flatMap((outcome) => outcome.workLogs),
      workLogTaskIds: outcomes.flatMap((outcome) => outcome.workLogTaskIds),
      removedTaskIds: outcomes.flatMap((outcome) => outcome.removedTaskIds),
      removedProjectIds: outcomes.flatMap((outcome) => outcome.removedProjectIds),
      archivedTaskIds: outcomes.flatMap((outcome) => outcome.archivedTaskIds),
      message: describeSuccess(outcomes, incrementalOnly),
      failures,
    };

    // Data first, then the status: listeners that react to "success" already see the new state.
    emitResult(result);
    notify("success", result.message);
    // Some accounts synced and some did not: report the failures after the data is in place.
    if (failures.length > 0) notify("error", failures.join("\n"));
    return result;
  } catch (err: unknown) {
    console.error("Sync failed:", err);
    notify("error", getErrorMessage(err));
    throw err;
  } finally {
    isSyncing = false;
    if (syncPending) {
      const full = pendingFull;
      syncPending = false;
      pendingFull = false;
      syncNow({ full }).catch((err: unknown) => {
        console.error("Pending sync failed:", err);
        notify("error", getErrorMessage(err));
      });
    }
  }
}

export function startBackgroundSync() {
  stopBackgroundSync();
  const accounts = getJiraAccounts();
  if (accounts.length === 0) return;

  // Sync immediately, then every hour (incremental unless a full re-read is due)
  syncNow().catch(() => {});
  syncInterval = setInterval(() => {
    syncNow().catch(() => {});
  }, SYNC_INTERVAL_MS);
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
