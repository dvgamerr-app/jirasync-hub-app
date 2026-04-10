import type { WorkLog } from "@/types/jira";

export function isPendingDeleteWorkLog(workLog: WorkLog): boolean {
  return workLog.syncStatus === "pending_delete";
}

export function isPendingCreateWorkLog(workLog: WorkLog): boolean {
  return (
    workLog.syncStatus === "pending_create" ||
    // Treat local-only logs (no jiraWorklogId) as pending_create,
    // unless they are already marked for deletion.
    (workLog.jiraWorklogId == null && workLog.syncStatus !== "pending_delete")
  );
}

export function isVisibleWorkLog(workLog: WorkLog): boolean {
  return !isPendingDeleteWorkLog(workLog);
}

export function toSyncedWorkLog(workLog: WorkLog, jiraWorklogId: string): WorkLog {
  return {
    ...workLog,
    jiraWorklogId,
    syncStatus: "synced",
  };
}
