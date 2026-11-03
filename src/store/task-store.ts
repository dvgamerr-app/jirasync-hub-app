import { create } from "zustand";
import {
  DirtyField,
  Organization,
  Project,
  Task,
  WorkLog,
  StoryLevel,
  TaskType,
  Severity,
} from "@/types/jira";
import { isSyncLockHeld, runExclusiveSync } from "@/lib/sync-lock";
import { syncNow, type SyncResult } from "@/lib/sync-service";
import { getDescriptionSearchText } from "@/lib/adf-content";
import { buildAiContext } from "@/lib/ai-context";
import { db, getJiraAccounts, getStoryPointFieldMap, type JiraAccount } from "@/lib/jira-db";
import {
  getAccountIdFromTask,
  getOrganizationId,
  getProjectIdPrefix,
  getTaskIdPrefix,
} from "@/lib/jira-ids";
import {
  updateJiraIssue,
  transitionJiraIssue,
  addJiraWorkLog,
  addJiraComment,
  deleteJiraWorkLog,
  fetchFreshJiraTask,
  fetchJiraTransitionTargets,
} from "@/lib/jira-api";
import {
  isCountedWorkLog,
  isOwnWorkLog,
  isPendingCreateWorkLog,
  isPendingDeleteWorkLog,
  isVisibleWorkLog,
  toSyncedWorkLog,
} from "@/lib/worklog-sync";
import { formatMandayEstimate, parseTimeInput } from "@/lib/worklog-time";
import { getErrorMessage } from "@/lib/utils";
import {
  DONE_TASK_STATUSES,
  isJiraDone,
  isAiBoardCompletedByJira,
  isAiBoardStatus,
  getAiBoardStatus,
  type AiBoardTaskState,
} from "@/lib/ai-board";
import {
  deleteRepoBinding,
  getRunEvents,
  harnessDoctor,
  listRepoBindings,
  listRuns,
  mergeRunEvents,
  RUN_EVENT_PAGE,
  removeRunWorktree,
  resumeRun,
  aiBoardStatusForRun,
  saveRepoBinding,
  startRun,
  stopRun,
  type DoctorReport,
  type RepoBinding,
  type RunEvent,
  type RunRecord,
  type RunDecision,
} from "@/lib/harness";

function getVisibleWorkLogsForTask(workLogs: WorkLog[], taskId: string): WorkLog[] {
  return workLogs.filter((wl) => wl.taskId === taskId && isVisibleWorkLog(wl));
}

export type TaskStatusFilter = "active" | "done" | "all";
export type TaskScopeFilter = "my-work" | "created-by-me";

export type SummaryOperation = "comment" | "worklog";
export type SummaryStatus = "idle" | "pending" | "done" | "error" | "unknown";
export interface SummaryDraft {
  accountId: string;
  taskId: string;
  jiraTaskId: string;
  summary: string;
  timeInput: string;
  logDate: string;
  worklogComment: string;
  commentStatus: SummaryStatus;
  worklogStatus: SummaryStatus;
  commentError: string;
  worklogError: string;
}
type SummaryInput = Pick<SummaryDraft, "summary" | "timeInput" | "logDate" | "worklogComment">;

export interface TaskStore {
  organizations: Organization[];
  projects: Project[];
  tasks: Task[];
  workLogs: WorkLog[];
  isLoaded: boolean;

  selectedProjectId: string | null;
  selectedTaskId: string | null;
  taskScopeFilter: TaskScopeFilter;
  taskStatusFilter: TaskStatusFilter;
  taskDetailViewMode: "details" | "description";
  /** Statuses each task can move to in Jira right now (loaded lazily; absent = unknown). */
  transitionOptions: Record<string, { statuses: string[]; fetchedAt: number }>;
  /** How many push/discard operations are queued behind a running sync (0 = none waiting). */
  waitingForSync: number;
  searchQuery: string;
  hiddenProjectIds: Set<string>;
  boardProjectId: string | null;
  boardTaskId: string | null;
  boardSearch: string;
  boardCopyTaskId: string | null;
  boardSyncing: boolean;
  boardHiddenProjectIds: Set<string>;
  toggleBoardProjectVisibility: (projectId: string) => void;
  aiBoardStates: AiBoardTaskState[];
  setBoardProject: (projectId: string | null) => void;
  setBoardTask: (taskId: string | null) => void;
  setBoardSearch: (query: string) => void;
  setBoardCopyTask: (taskId: string | null) => void;
  setBoardSyncing: (syncing: boolean) => void;
  pullBoard: () => Promise<void>;
  moveBoardTask: (taskId: string, status: string) => Promise<void>;
  summaryTaskId: string | null;
  summaryDrafts: Record<string, SummaryDraft>;
  openSummary: (taskId: string) => void;
  closeSummary: () => void;
  updateSummaryDraft: (taskId: string, updates: Partial<SummaryInput>) => void;
  resetSummaryOperation: (taskId: string, operation: SummaryOperation) => void;
  submitSummaryOperation: (taskId: string, operation: SummaryOperation) => Promise<void>;

  /** Agent harness (native core): tool readiness and per-project repo bindings. */
  harnessSetupOpen: boolean;
  harnessDoctor: DoctorReport | null;
  harnessDoctorError: string | null;
  harnessDoctorRunning: boolean;
  repoBindings: RepoBinding[];
  setHarnessSetupOpen: (open: boolean) => void;
  runHarnessDoctor: () => Promise<DoctorReport | null>;
  /** First AI Board visit only: check tools and open Setup when a required one is not ready. */
  openHarnessSetupOnFirstVisit: () => Promise<void>;
  loadRepoBindings: () => Promise<void>;
  saveRepoBinding: (binding: RepoBinding) => Promise<RepoBinding>;
  removeRepoBinding: (projectId: string) => Promise<void>;
  /** Runs (newest first) and their journal events, as far as this window has loaded them. */
  runs: RunRecord[];
  runEvents: Record<string, RunEvent[]>;
  loadRuns: () => Promise<void>;
  /** Replays journal events after the last one this window has (fills gaps, no duplicates). */
  loadRunEvents: (runId: string) => Promise<void>;
  applyRunEvent: (event: RunEvent) => void;
  /**
   * Starts a run for the task in the repo bound to its project (one busy run at a time).
   * `agent` sends the task snapshot to Claude, which plans first and waits for approval.
   */
  startTaskRun: (
    taskId: string,
    options?: { agent?: boolean; includeNote?: boolean },
  ) => Promise<RunRecord>;
  /** The owner decision at a gate of an agent run (plan approval, review). */
  resumeTaskRun: (runId: string, decision: RunDecision, feedback?: string) => Promise<void>;
  stopTaskRun: (runId: string) => Promise<void>;
  removeTaskRunWorktree: (runId: string, discardChanges: boolean) => Promise<void>;

  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;
  setTaskScopeFilter: (filter: TaskScopeFilter) => void;
  setTaskStatusFilter: (filter: TaskStatusFilter) => void;
  setTaskDetailViewMode: (mode: "details" | "description") => void;
  setSearchQuery: (query: string) => void;
  toggleProjectVisibility: (projectId: string) => void;

  loadFromDB: () => Promise<void>;
  reloadFromDB: () => Promise<void>;
  loadTransitionOptions: (taskId: string) => Promise<void>;
  /** Merge what a pull just wrote to IndexedDB straight into state (no DB read). */
  applySyncResult: (result: SyncResult) => void;

  updateTaskStatus: (taskId: string, status: string) => void;
  updateTaskStoryLevel: (taskId: string, level: StoryLevel | null) => void;
  updateTaskMandays: (taskId: string, mandays: number | null) => void;
  updateTaskType: (taskId: string, type: TaskType | null) => void;
  updateTaskSeverity: (taskId: string, severity: Severity | null) => void;
  updateTaskRefUrl: (taskId: string, refUrl: string | null) => void;
  /** The note is local-only: saving it never marks the task dirty or touches Jira. */
  updateTaskNote: (taskId: string, note: string | null) => void;
  /** Explicitly send text to Jira as a new comment (one-off; not synced state). */
  postNoteAsComment: (taskId: string, text: string) => Promise<void>;

  addWorkLog: (log: Omit<WorkLog, "id" | "createdAt">) => Promise<void>;
  removeWorkLog: (logId: string) => void;

  syncTaskToJira: (taskId: string) => Promise<void>;
  syncAllDirtyTasks: () => Promise<void>;
  discardTask: (taskId: string) => Promise<void>;
  discardAllDirtyTasks: () => Promise<void>;
  getDirtyTaskCount: () => number;

  getFilteredTasks: () => Task[];
  getVisibleProjects: () => Project[];
  getStatusesForProject: (projectId: string) => string[];
  getWorkLogsForTask: (taskId: string) => WorkLog[];
  getTaskById: (taskId: string) => Task | undefined;
  getProjectById: (projectId: string) => Project | undefined;
  getTotalTimeForTask: (taskId: string) => number;
}

const SEVERITY_TO_PRIORITY: Record<string, string> = {
  Critical: "Highest",
  High: "High",
  Medium: "Medium",
  Low: "Low",
};

const TRANSITION_CACHE_MS = 60_000;

/**
 * Statuses to offer for a task: what its workflow allows from Jira's current status, plus the
 * status currently shown (it may be an unpushed local choice). Unknown → every project status.
 */
export function getSelectableStatuses(
  projectStatuses: string[],
  currentStatus: string | null,
  reachable: string[] | undefined,
): string[] {
  if (!reachable) return projectStatuses;
  return [...new Set([...(currentStatus ? [currentStatus] : []), ...reachable])];
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function upsertById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

/** Logs and collects the rejected results of a per-task batch (push or discard). */
function collectTaskFailures(
  settled: PromiseSettledResult<unknown>[],
  tasks: Task[],
  action: string,
): { jiraId: string; reason: unknown }[] {
  const failures: { jiraId: string; reason: unknown }[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status !== "rejected") continue;
    failures.push({ jiraId: tasks[index].jiraTaskId, reason: result.reason });
    console.error(`${action} failed for ${tasks[index].jiraTaskId}:`, result.reason);
  }
  return failures;
}

export const INACTIVE_STATUSES = DONE_TASK_STATUSES;

type ScopedTaskCollections = Pick<
  TaskStore,
  "organizations" | "projects" | "tasks" | "workLogs" | "aiBoardStates"
>;

function getAccountForTask(task: Task, accounts: JiraAccount[]): JiraAccount | undefined {
  const accountId = getAccountIdFromTask(task);
  if (!accountId) return undefined;
  return accounts.find((a) => a.id === accountId);
}

// Fields a user can edit locally. refUrl is tracked so a pull does not overwrite it, but it is
// never sent to Jira.
const TRACKED_FIELDS: ReadonlySet<DirtyField> = new Set<DirtyField>([
  "status",
  "type",
  "severity",
  "storyLevel",
  "mandays",
  "refUrl",
]);

/**
 * Dirty fields after applying `updates` to `task`. A dirty task without `dirtyFields` is a
 * legacy record from before per-field tracking: keep it "everything is dirty".
 */
function nextDirtyFields(task: Task, updates: Partial<Task>): DirtyField[] | undefined {
  if (task.isDirty && task.dirtyFields === undefined) return undefined;
  const changed = (Object.keys(updates) as DirtyField[]).filter((key) => TRACKED_FIELDS.has(key));
  return [...new Set([...(task.dirtyFields ?? []), ...changed])];
}

function isFieldDirty(task: Pick<Task, "dirtyFields">, field: DirtyField): boolean {
  return task.dirtyFields === undefined || task.dirtyFields.includes(field);
}

async function pushTaskToJira(task: Task, accounts: JiraAccount[]): Promise<void> {
  const account = getAccountForTask(task, accounts);
  if (!account) return;

  const storyPointFieldMap = getStoryPointFieldMap();
  const storyPointFieldId = storyPointFieldMap[task.projectId];

  // Send only what the user actually edited. Re-sending untouched fields would overwrite
  // changes made in Jira meanwhile and can alter data the app does not model faithfully
  // (e.g. a story point of 8 that the UI cannot represent, or a priority outside the 4 levels).
  const fields: Record<string, unknown> = {};
  // Only send the story point field when this project has one mapped in Jira
  // Settings — guessing the default field id makes Jira reject the whole
  // update (400) for projects where that field isn't on the edit screen.
  if (storyPointFieldId && isFieldDirty(task, "storyLevel")) {
    fields[storyPointFieldId] = task.storyLevel ?? null;
  }
  if (
    isFieldDirty(task, "severity") &&
    task.severity &&
    task.severity !== "NA" &&
    SEVERITY_TO_PRIORITY[task.severity]
  ) {
    fields.priority = { name: SEVERITY_TO_PRIORITY[task.severity] };
  } else if (
    task.dirtyFields !== undefined &&
    isFieldDirty(task, "severity") &&
    (!task.severity || task.severity === "NA")
  ) {
    // "NA" has no Jira priority: clear it explicitly. Projects that require a priority reject
    // this with a 400, which surfaces as a push error instead of a silent no-op.
    fields.priority = null;
  }
  if (isFieldDirty(task, "type") && task.type) {
    fields.issuetype = { name: task.type };
  }

  // If mandays set, convert to Jira timetracking originalEstimate
  if (isFieldDirty(task, "mandays") && task.mandays === null && task.dirtyFields !== undefined) {
    // The estimate was cleared locally: clear it in Jira too (an empty estimate string).
    fields.timetracking = { originalEstimate: "" };
  } else if (
    isFieldDirty(task, "mandays") &&
    typeof task.mandays === "number" &&
    !isNaN(task.mandays)
  ) {
    const { str: estimateStr, seconds } = formatMandayEstimate(task.mandays);
    fields.timetracking = {
      originalEstimate: estimateStr,
      originalEstimateSeconds: seconds,
    };
  }

  if (Object.keys(fields).length > 0) {
    try {
      await updateJiraIssue(account, task.jiraTaskId, fields);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed updating issue ${task.jiraTaskId}:`, err);
      throw new Error(`Failed updating ${task.jiraTaskId}: ${message}`, { cause: err });
    }
  }

  if (task.status && isFieldDirty(task, "status")) {
    try {
      await transitionJiraIssue(account, task.jiraTaskId, task.status);
    } catch (err: unknown) {
      console.warn(`Transition failed for ${task.jiraTaskId} → "${task.status}":`, err);
      // A legacy dirty record (no dirtyFields) re-sends its status even when it never changed;
      // Jira then has no transition to the current status. That is not a user-facing failure.
      if (task.dirtyFields === undefined) return;
      // Surface this: the task must stay unsynced so the user sees the status was not applied.
      throw new Error(
        `Could not move ${task.jiraTaskId} to "${task.status}": ${getErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

async function persistTask(task: Task): Promise<void> {
  await db.tasks.put(task);
}

function persistTaskInBackground(task: Task): void {
  void persistTask(task).catch((error) => {
    console.error(`Failed to persist task ${task.id}:`, error);
  });
}

function persistWorkLogInBackground(workLog: WorkLog): void {
  void db.workLogs.put(workLog).catch((error) => {
    console.error(`Failed to persist worklog ${workLog.id}:`, error);
  });
}

function deleteWorkLogInBackground(workLogId: string): void {
  void db.workLogs.delete(workLogId).catch((error) => {
    console.error(`Failed to delete worklog ${workLogId}:`, error);
  });
}

async function loadScopedCollections(accountIds: string[]): Promise<ScopedTaskCollections> {
  if (accountIds.length === 0) {
    return {
      organizations: [],
      projects: [],
      tasks: [],
      workLogs: [],
      aiBoardStates: [],
    };
  }

  const [organizationRows, projectGroups] = await Promise.all([
    db.organizations.bulkGet(accountIds.map(getOrganizationId)),
    Promise.all(
      accountIds.map((accountId) =>
        db.projects.where("id").startsWith(getProjectIdPrefix(accountId)).toArray(),
      ),
    ),
  ]);

  const organizations = organizationRows
    .filter((organization): organization is Organization => organization !== undefined)
    .sort((left, right) => compareScopedEntityOrder(left.id, right.id, accountIds, "organization"));
  const projects = projectGroups
    .flat()
    .sort((left, right) => compareScopedEntityOrder(left.id, right.id, accountIds, "project"));
  const visibleProjectIds = new Set(projects.map((project) => project.id));
  const tasks = (
    await Promise.all(
      accountIds.map((accountId) =>
        db.tasks.where("id").startsWith(getTaskIdPrefix(accountId)).toArray(),
      ),
    )
  )
    .flat()
    .filter((task) => visibleProjectIds.has(task.projectId));
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const workLogs = (
    await Promise.all(
      accountIds.map((accountId) =>
        db.workLogs.where("taskId").startsWith(getTaskIdPrefix(accountId)).toArray(),
      ),
    )
  )
    .flat()
    .filter((workLog) => visibleTaskIds.has(workLog.taskId));

  return {
    organizations,
    projects,
    tasks,
    workLogs,
    aiBoardStates: await db.aiBoardStates.where("accountId").anyOf(accountIds).toArray(),
  };
}

function compareScopedEntityOrder(
  leftId: string,
  rightId: string,
  accountIds: string[],
  entityType: "organization" | "project",
): number {
  const leftIndex = getScopedEntityAccountIndex(leftId, accountIds, entityType);
  const rightIndex = getScopedEntityAccountIndex(rightId, accountIds, entityType);

  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  return leftId.localeCompare(rightId);
}

function getScopedEntityAccountIndex(
  entityId: string,
  accountIds: string[],
  entityType: "organization" | "project",
): number {
  const accountIndex = accountIds.findIndex((accountId) =>
    entityType === "organization"
      ? entityId === getOrganizationId(accountId)
      : entityId.startsWith(getProjectIdPrefix(accountId)),
  );

  return accountIndex === -1 ? Number.MAX_SAFE_INTEGER : accountIndex;
}

function replaceTask(tasks: Task[], nextTask: Task): Task[] {
  return tasks.map((task) => (task.id === nextTask.id ? nextTask : task));
}

/** Swaps all of one task's worklogs for a fresh set read back from IndexedDB. */
function replaceTaskWorkLogs(workLogs: WorkLog[], taskId: string, fresh: WorkLog[]): WorkLog[] {
  return [...workLogs.filter((workLog) => workLog.taskId !== taskId), ...fresh];
}

function replaceWorkLog(workLogs: WorkLog[], nextWorkLog: WorkLog): WorkLog[] {
  return workLogs.map((workLog) => (workLog.id === nextWorkLog.id ? nextWorkLog : workLog));
}

function removeWorkLog(workLogs: WorkLog[], workLogId: string): WorkLog[] {
  return workLogs.filter((workLog) => workLog.id !== workLogId);
}

function formatTaskFailures(failures: { jiraId: string; reason: unknown }[]): string {
  return failures
    .map((failure) => `${failure.jiraId} (${getErrorMessage(failure.reason)})`)
    .join("; ");
}

export function isDoneTask(task: Pick<Task, "status" | "statusCategory">): boolean {
  return isJiraDone(task);
}

function buildChildrenByParentKey(tasks: Task[]): Record<string, Task[]> {
  const map: Record<string, Task[]> = {};
  for (const task of tasks) {
    if (task.isEpic !== true && task.parentKey) {
      map[task.parentKey] ??= [];
      map[task.parentKey].push(task);
    }
  }
  return map;
}

function getDescendants(rootKey: string, childrenByParentKey: Record<string, Task[]>): Task[] {
  const result: Task[] = [];
  const queue = [...(childrenByParentKey[rootKey] ?? [])];
  while (queue.length > 0) {
    const task = queue.shift()!;
    result.push(task);
    queue.push(...(childrenByParentKey[task.jiraTaskId] ?? []));
  }
  return result;
}

// An epic whose subtasks are all done has nothing left to work on — drop it from the
// active list even though the epic itself is not marked done in Jira.
function isFullyCompletedEpic(epic: Task, childrenByParentKey: Record<string, Task[]>): boolean {
  const descendants = getDescendants(epic.jiraTaskId, childrenByParentKey);
  return descendants.length > 0 && descendants.every((task) => isDoneTask(task));
}

function matchesTaskScope(
  task: Pick<Task, "isCreatedByCurrentUser" | "isCurrentAssignee">,
  taskScopeFilter: TaskScopeFilter,
): boolean {
  const isCreatedForTracking =
    task.isCreatedByCurrentUser === true && task.isCurrentAssignee === false;
  return taskScopeFilter === "created-by-me" ? isCreatedForTracking : !isCreatedForTracking;
}

// A task still in the Jira "To Do" category that is no longer assigned to us was reassigned
// before work started — drop it from the active list, keep only our latest assignment.
function isStaleReassignedTask(task: Pick<Task, "statusCategory" | "isCurrentAssignee">): boolean {
  return task.statusCategory === "new" && task.isCurrentAssignee === false;
}

function matchesTaskStatusFilter(
  task: Pick<Task, "status" | "isArchived" | "statusCategory" | "isCurrentAssignee">,
  taskStatusFilter: TaskStatusFilter,
  taskScopeFilter: TaskScopeFilter,
): boolean {
  switch (taskStatusFilter) {
    case "done":
      return isDoneTask(task) && !task.isArchived;
    case "active":
      return (
        !isDoneTask(task) &&
        !task.isArchived &&
        (taskScopeFilter === "created-by-me" || !isStaleReassignedTask(task))
      );
    case "all":
    default:
      return true;
  }
}

function getVisibleTasks(
  tasks: Task[],
  selectedProjectId: string | null,
  taskStatusFilter: TaskStatusFilter,
  taskScopeFilter: TaskScopeFilter,
): Task[] {
  const filteredByProject = selectedProjectId
    ? tasks.filter((task) => task.projectId === selectedProjectId)
    : tasks;

  const visible = filteredByProject.filter(
    (task) =>
      matchesTaskScope(task, taskScopeFilter) &&
      ((taskScopeFilter === "my-work" && task.isEpic === true) ||
        matchesTaskStatusFilter(task, taskStatusFilter, taskScopeFilter)),
  );

  if (taskStatusFilter !== "active") return visible;

  const childrenByParentKey = buildChildrenByParentKey(filteredByProject);
  return visible.filter(
    (task) => task.isEpic !== true || !isFullyCompletedEpic(task, childrenByParentKey),
  );
}

export function filterTasks(
  tasks: Task[],
  selectedProjectId: string | null,
  taskStatusFilter: TaskStatusFilter,
  searchQuery: string,
  hiddenProjectIds: Set<string>,
  taskScopeFilter: TaskScopeFilter = "my-work",
): Task[] {
  let filtered = getVisibleTasks(tasks, selectedProjectId, taskStatusFilter, taskScopeFilter);
  if (!selectedProjectId && hiddenProjectIds.size > 0) {
    filtered = filtered.filter((task) => !hiddenProjectIds.has(task.projectId));
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (normalizedQuery) {
    filtered = filtered.filter(
      (task) =>
        task.jiraTaskId.toLowerCase().includes(normalizedQuery) ||
        task.title.toLowerCase().includes(normalizedQuery) ||
        getDescriptionSearchText(task.description).includes(normalizedQuery),
    );
  }

  return filtered.sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function getVisibleProjectIds(
  tasks: Task[],
  projects: Project[],
  taskStatusFilter: TaskStatusFilter,
  taskScopeFilter: TaskScopeFilter,
): Set<string> {
  const knownProjectIds = new Set(projects.map((project) => project.id));
  const visibleTasks = getVisibleTasks(tasks, null, taskStatusFilter, taskScopeFilter);

  return new Set(
    visibleTasks
      .filter((task) => knownProjectIds.has(task.projectId))
      .map((task) => task.projectId),
  );
}

function getNormalizedSelectionState(
  tasks: Task[],
  projects: Project[],
  selectedProjectId: string | null,
  selectedTaskId: string | null,
  taskStatusFilter: TaskStatusFilter,
  taskScopeFilter: TaskScopeFilter,
): Pick<TaskStore, "selectedProjectId" | "selectedTaskId"> {
  const visibleProjectIds = getVisibleProjectIds(
    tasks,
    projects,
    taskStatusFilter,
    taskScopeFilter,
  );
  const nextSelectedProjectId =
    selectedProjectId && !visibleProjectIds.has(selectedProjectId) ? null : selectedProjectId;
  const visibleTaskIds = new Set(
    getVisibleTasks(tasks, nextSelectedProjectId, taskStatusFilter, taskScopeFilter).map(
      (task) => task.id,
    ),
  );

  return {
    selectedProjectId: nextSelectedProjectId,
    selectedTaskId: selectedTaskId && !visibleTaskIds.has(selectedTaskId) ? null : selectedTaskId,
  };
}

function buildDirtyTask(task: Task, updates: Partial<Task>): Task {
  const updated: Task = {
    ...task,
    ...updates,
    dirtyFields: nextDirtyFields(task, updates),
    isDirty: true,
    isSynced: false,
    // Strictly increasing, so two edits in the same millisecond still differ (the push compares it).
    updatedAt: new Date(Math.max(Date.now(), (Date.parse(task.updatedAt) || 0) + 1)).toISOString(),
  };
  return updated;
}

function markDirtyAndPersist(task: Task, updates: Partial<Task>): Task {
  const updated = buildDirtyTask(task, updates);
  persistTaskInBackground(updated);
  return updated;
}

async function persistSyncedTask(task: Task, latest?: Task): Promise<Task> {
  // The user kept editing while the push was in flight. `task` is the snapshot that was sent,
  // so writing it back as "synced" would erase those newer edits. Keep the newer, still-dirty
  // record; its (idempotent) fields are simply pushed again next time.
  if (latest && latest.updatedAt !== task.updatedAt) return latest;

  // The note is saved without bumping updatedAt, so carry over whatever it is now.
  const synced: Task = {
    ...task,
    note: latest ? latest.note : task.note,
    isDirty: false,
    isSynced: true,
    dirtyFields: [],
  };
  await persistTask(synced);
  return synced;
}

async function syncTaskWorkLogsToJira(task: Task, account: JiraAccount): Promise<void> {
  const taskWorkLogs = await db.workLogs.where("taskId").equals(task.id).toArray();

  await Promise.all(
    taskWorkLogs.filter(isPendingCreateWorkLog).map(async (workLog) => {
      const jiraWorklogId = await addJiraWorkLog(
        account,
        task.jiraTaskId,
        workLog.timeSpentMinutes,
        workLog.logDate,
        workLog.comment,
      );
      if (!jiraWorklogId) throw new Error(`Failed creating worklog for ${task.jiraTaskId}`);
      await db.workLogs.put(toSyncedWorkLog(workLog, jiraWorklogId));
    }),
  );

  await Promise.all(
    taskWorkLogs.filter(isPendingDeleteWorkLog).map(async (workLog) => {
      if (workLog.jiraWorklogId) {
        await deleteJiraWorkLog(account, task.jiraTaskId, workLog.jiraWorklogId);
      }
      await db.workLogs.delete(workLog.id);
    }),
  );
}

async function syncDirtyTask(
  task: Task,
  accounts: JiraAccount[],
  getLatest: (taskId: string) => Task | undefined,
): Promise<Task | null> {
  const account = getAccountForTask(task, accounts);
  if (!account) return null;

  // Fields and worklogs are independent in Jira: a rejected field update (no edit permission,
  // blocked transition) must not stop the user's logged time from being pushed.
  const errors: string[] = [];
  try {
    await pushTaskToJira(task, accounts);
  } catch (err: unknown) {
    errors.push(getErrorMessage(err));
  }
  try {
    await syncTaskWorkLogsToJira(task, account);
  } catch (err: unknown) {
    errors.push(`Worklog sync failed for ${task.jiraTaskId}: ${getErrorMessage(err)}`);
  }
  if (errors.length > 0) throw new Error(errors.join("; "));

  return persistSyncedTask(task, getLatest(task.id));
}

async function replaceTaskWorkLogsWithFresh(
  taskId: string,
  freshWorkLogs: WorkLog[],
): Promise<void> {
  const existing = await db.workLogs.where("taskId").equals(taskId).toArray();
  await db.transaction("rw", db.workLogs, async () => {
    if (existing.length > 0) await db.workLogs.bulkDelete(existing.map((workLog) => workLog.id));
    if (freshWorkLogs.length > 0) await db.workLogs.bulkPut(freshWorkLogs);
  });
}

async function discardDirtyTask(task: Task, accounts: JiraAccount[]): Promise<Task | null> {
  const account = getAccountForTask(task, accounts);
  if (!account) return null;

  const { task: freshTask, workLogs: freshWorkLogs } = await fetchFreshJiraTask(
    account,
    task.jiraTaskId,
  );
  // The note is local-only: Jira never held it, so restoring from Jira must not erase it.
  const restored: Task = { ...freshTask, isArchived: task.isArchived, note: task.note };
  await persistTask(restored);
  await replaceTaskWorkLogsWithFresh(task.id, freshWorkLogs);
  return restored;
}

const HIDDEN_PROJECTS_KEY = "jirasync-hidden-projects";
const BOARD_HIDDEN_PROJECTS_KEY = "jirasync-ai-hidden-projects";
const HARNESS_SETUP_SEEN_KEY = "jirasync-harness-setup-seen";

function loadHiddenProjectIds(key = HIDDEN_PROJECTS_KEY): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function saveHiddenProjectIds(ids: Set<string>, key = HIDDEN_PROJECTS_KEY): void {
  localStorage.setItem(key, JSON.stringify([...ids]));
}

export const useTaskStore = create<TaskStore>((set, get) => {
  let initialLoad: Promise<void> | null = null;
  const refreshStoreFromDB = async (markAsLoaded: boolean): Promise<void> => {
    const collections = await loadScopedCollections(getJiraAccounts().map((account) => account.id));
    const currentState = get();
    const normalizedSelection = getNormalizedSelectionState(
      collections.tasks,
      collections.projects,
      currentState.selectedProjectId,
      currentState.selectedTaskId,
      currentState.taskStatusFilter,
      currentState.taskScopeFilter,
    );

    set({
      ...collections,
      ...(markAsLoaded ? { isLoaded: true } : {}),
      ...normalizedSelection,
    });
  };

  // Push/discard share one lock with pull. When a pull is running the caller queues behind it, so
  // expose that (waitingForSync) instead of leaving the UI looking frozen.
  const runLocked = <T>(operation: () => Promise<T>): Promise<T> => {
    const mustWait = isSyncLockHeld();
    if (mustWait) set((state) => ({ waitingForSync: state.waitingForSync + 1 }));
    return runExclusiveSync(async () => {
      if (mustWait) set((state) => ({ waitingForSync: state.waitingForSync - 1 }));
      return operation();
    });
  };

  const getLatestTask = (taskId: string): Task | undefined =>
    get().tasks.find((task) => task.id === taskId);

  const updateTask = (taskId: string, updates: Partial<Task>) => {
    set((state) => {
      const tasks = state.tasks.map((task) =>
        task.id === taskId ? markDirtyAndPersist(task, updates) : task,
      );
      const normalizedSelection = getNormalizedSelectionState(
        tasks,
        state.projects,
        state.selectedProjectId,
        state.selectedTaskId,
        state.taskStatusFilter,
        state.taskScopeFilter,
      );

      return {
        tasks,
        ...normalizedSelection,
      };
    });
  };

  return {
    organizations: [],
    projects: [],
    tasks: [],
    workLogs: [],
    isLoaded: false,

    selectedProjectId: null,
    selectedTaskId: null,
    taskScopeFilter: "my-work",
    taskStatusFilter: "active",
    taskDetailViewMode: "details",
    transitionOptions: {},
    waitingForSync: 0,
    searchQuery: "",
    hiddenProjectIds: loadHiddenProjectIds(),
    boardProjectId: null,
    boardTaskId: null,
    boardSearch: "",
    boardCopyTaskId: null,
    boardSyncing: false,
    boardHiddenProjectIds: loadHiddenProjectIds(BOARD_HIDDEN_PROJECTS_KEY),
    toggleBoardProjectVisibility: (projectId) => {
      const state = get();
      const hidden = new Set(state.boardHiddenProjectIds);
      if (hidden.has(projectId)) hidden.delete(projectId);
      else hidden.add(projectId);
      saveHiddenProjectIds(hidden, BOARD_HIDDEN_PROJECTS_KEY);
      set({ boardHiddenProjectIds: hidden });
    },
    aiBoardStates: [],
    setBoardProject: (projectId) => set({ boardProjectId: projectId, boardTaskId: null }),
    setBoardTask: (taskId) => set({ boardTaskId: taskId }),
    setBoardSearch: (query) => set({ boardSearch: query }),
    setBoardCopyTask: (taskId) => set({ boardCopyTaskId: taskId }),
    setBoardSyncing: (syncing) => set({ boardSyncing: syncing }),
    pullBoard: async () => {
      if (get().boardSyncing) return;
      await syncNow({ full: true });
    },
    moveBoardTask: (taskId, status) =>
      runLocked(async () => {
        const task = getLatestTask(taskId);
        if (!task) throw new Error("This ticket is no longer available");
        if (!isAiBoardStatus(status)) throw new Error("Unknown AI workflow status");
        const account = getAccountForTask(task, getJiraAccounts());
        if (!account) throw new Error("This ticket's Jira account is no longer configured");
        const previous = get().aiBoardStates.find((state) => state.id === taskId);
        const jiraDone = isAiBoardCompletedByJira(task, previous);
        if (jiraDone && status !== "done")
          throw new Error("This task is completed in Jira. Its AI work stays Done.");
        const next: AiBoardTaskState = {
          id: taskId,
          accountId: account.id,
          status,
          jiraDone,
          updatedAt: new Date().toISOString(),
        };
        await db.aiBoardStates.put(next);
        set((state) => ({ aiBoardStates: upsertById(state.aiBoardStates, [next]) }));
      }),
    harnessSetupOpen: false,
    harnessDoctor: null,
    harnessDoctorError: null,
    harnessDoctorRunning: false,
    repoBindings: [],
    setHarnessSetupOpen: (open) => set({ harnessSetupOpen: open }),
    runHarnessDoctor: async () => {
      set({ harnessDoctorRunning: true, harnessDoctorError: null });
      try {
        const report = await harnessDoctor();
        set({ harnessDoctor: report, harnessDoctorRunning: false });
        return report;
      } catch (error) {
        set({ harnessDoctorError: getErrorMessage(error), harnessDoctorRunning: false });
        return null;
      }
    },
    openHarnessSetupOnFirstVisit: async () => {
      try {
        if (localStorage.getItem(HARNESS_SETUP_SEEN_KEY)) return;
        localStorage.setItem(HARNESS_SETUP_SEEN_KEY, "1");
      } catch {
        return;
      }
      const report = await get().runHarnessDoctor();
      if (report && !report.ready) set({ harnessSetupOpen: true });
    },
    loadRepoBindings: async () => {
      set({ repoBindings: await listRepoBindings() });
    },
    saveRepoBinding: async (binding) => {
      const saved = await saveRepoBinding(binding);
      set((state) => ({
        repoBindings: [
          ...state.repoBindings.filter((existing) => existing.projectId !== saved.projectId),
          saved,
        ],
      }));
      return saved;
    },
    removeRepoBinding: async (projectId) => {
      await deleteRepoBinding(projectId);
      set((state) => ({
        repoBindings: state.repoBindings.filter((existing) => existing.projectId !== projectId),
      }));
    },
    runs: [],
    runEvents: {},
    loadRuns: async () => {
      set({ runs: await listRuns() });
    },
    loadRunEvents: async (runId) => {
      // The journal answers in pages; keep reading so the newest events are never skipped.
      for (;;) {
        const after = get().runEvents[runId]?.at(-1)?.seq ?? 0;
        const events = await getRunEvents(runId, after);
        if (events.length === 0) return;
        set((state) => ({
          runEvents: {
            ...state.runEvents,
            [runId]: mergeRunEvents(state.runEvents[runId] ?? [], events),
          },
        }));
        if (events.length < RUN_EVENT_PAGE) return;
      }
    },
    applyRunEvent: (event) => {
      const current = get().runEvents[event.runId] ?? [];
      const last = current.at(-1)?.seq ?? 0;
      if (event.seq <= last) return;
      if (event.seq > last + 1) {
        // Missed events (e.g. the window reloaded mid-run): replay them from the journal.
        void get()
          .loadRunEvents(event.runId)
          .catch(() => {});
        return;
      }
      set((state) => ({
        runEvents: { ...state.runEvents, [event.runId]: mergeRunEvents(current, [event]) },
      }));
      // Status changes also update the record (worktree path, plan, checks, error).
      if (event.type !== "status") return;
      const status = event.status;
      void get()
        .loadRuns()
        .then(() => {
          // Agent progress shows on the AI Board; the board never changes Jira.
          const run = get().runs.find((candidate) => candidate.runId === event.runId);
          const target = aiBoardStatusForRun(status);
          const task = run ? getLatestTask(run.taskId) : undefined;
          if (!run || run.mode !== "agent" || !target || !task) return;
          const state = get().aiBoardStates.find((candidate) => candidate.id === task.id);
          if (isAiBoardCompletedByJira(task, state) || getAiBoardStatus(task, state) === target)
            return;
          return get().moveBoardTask(task.id, target);
        })
        .catch(() => {});
    },
    startTaskRun: async (taskId, options = {}) => {
      const task = getLatestTask(taskId);
      if (!task) throw new Error("This ticket is no longer available");
      const parent = get().tasks.find(
        (candidate) =>
          candidate.jiraTaskId === task.parentKey &&
          getAccountIdFromTask(candidate) === getAccountIdFromTask(task),
      );
      const context = options.agent
        ? buildAiContext(task, { parent, includeNote: options.includeNote })
        : null;
      const record = await startRun(task.id, task.projectId, task.jiraTaskId, context);
      set((state) => ({
        runs: [record, ...state.runs.filter((run) => run.runId !== record.runId)],
      }));
      return record;
    },
    resumeTaskRun: async (runId, decision, feedback) => {
      const record = await resumeRun(runId, decision, feedback);
      set((state) => ({
        runs: state.runs.map((run) => (run.runId === record.runId ? record : run)),
      }));
    },
    stopTaskRun: async (runId) => {
      await stopRun(runId);
    },
    removeTaskRunWorktree: async (runId, discardChanges) => {
      const record = await removeRunWorktree(runId, discardChanges);
      set((state) => ({
        runs: state.runs.map((run) => (run.runId === record.runId ? record : run)),
      }));
    },
    summaryTaskId: null,
    summaryDrafts: {},
    openSummary: (taskId) => {
      const task = getLatestTask(taskId);
      if (!task) return;
      const account = getAccountForTask(task, getJiraAccounts());
      if (!account) return;
      const now = new Date();
      const logDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      set((state) => ({
        summaryTaskId: taskId,
        summaryDrafts: {
          ...state.summaryDrafts,
          [taskId]: state.summaryDrafts[taskId] ?? {
            accountId: account.id,
            taskId,
            jiraTaskId: task.jiraTaskId,
            summary: "",
            timeInput: "",
            logDate,
            worklogComment: "",
            commentStatus: "idle",
            worklogStatus: "idle",
            commentError: "",
            worklogError: "",
          },
        },
      }));
    },
    closeSummary: () => set({ summaryTaskId: null }),
    updateSummaryDraft: (taskId, updates) =>
      set((state) => {
        const draft = state.summaryDrafts[taskId];
        if (!draft) return {};
        const next = { ...draft };
        if (draft.commentStatus === "idle" || draft.commentStatus === "error") {
          if (updates.summary !== undefined) next.summary = updates.summary;
        }
        if (draft.worklogStatus === "idle" || draft.worklogStatus === "error") {
          if (updates.timeInput !== undefined) next.timeInput = updates.timeInput;
          if (updates.logDate !== undefined) next.logDate = updates.logDate;
          if (updates.worklogComment !== undefined) next.worklogComment = updates.worklogComment;
        }
        return { summaryDrafts: { ...state.summaryDrafts, [taskId]: next } };
      }),
    resetSummaryOperation: (taskId, operation) =>
      set((state) => {
        const draft = state.summaryDrafts[taskId];
        if (!draft || draft[`${operation}Status`] === "pending") return {};
        return {
          summaryDrafts: {
            ...state.summaryDrafts,
            [taskId]: {
              ...draft,
              [`${operation}Status`]: "idle",
              [`${operation}Error`]: "",
              ...(operation === "comment"
                ? { summary: "" }
                : { timeInput: "", worklogComment: "" }),
            },
          },
        };
      }),
    submitSummaryOperation: async (taskId, operation) => {
      const draft = get().summaryDrafts[taskId];
      if (!draft || !["idle", "error"].includes(draft[`${operation}Status`])) return;
      const patch = (changes: Partial<SummaryDraft>) =>
        set((state) => ({
          summaryDrafts: {
            ...state.summaryDrafts,
            [taskId]: { ...state.summaryDrafts[taskId], ...changes },
          },
        }));
      patch({ [`${operation}Status`]: "pending", [`${operation}Error`]: "" });
      let sendingComment = false;
      try {
        const task = getLatestTask(taskId);
        if (!task || getAccountForTask(task, getJiraAccounts())?.id !== draft.accountId) {
          throw new Error("This ticket or its Jira account is no longer available");
        }
        if (operation === "comment") {
          if (!draft.summary.trim()) throw new Error("Enter a summary before posting");
          sendingComment = true;
          await get().postNoteAsComment(taskId, draft.summary);
        } else {
          const minutes = parseTimeInput(draft.timeInput);
          if (!minutes || !Number.isSafeInteger(minutes) || minutes <= 0)
            throw new Error("Enter a valid time, e.g. 30m or 2h");
          await get().addWorkLog({
            taskId,
            timeSpentMinutes: minutes,
            logDate: draft.logDate,
            comment: draft.worklogComment.trim() || null,
          });
        }
        patch({ [`${operation}Status`]: "done" });
      } catch (error) {
        const message = getErrorMessage(error);
        const uncertain = sendingComment && !/Jira API 4\d\d:/.test(message);
        patch({
          [`${operation}Status`]: uncertain ? "unknown" : "error",
          [`${operation}Error`]: uncertain
            ? `Result unknown. Check Jira before starting a new comment. ${message}`
            : message,
        });
      }
    },

    setSelectedProject: (projectId) => set({ selectedProjectId: projectId, selectedTaskId: null }),
    setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),
    setTaskScopeFilter: (taskScopeFilter) =>
      set({ taskScopeFilter, selectedProjectId: null, selectedTaskId: null }),
    setTaskStatusFilter: (taskStatusFilter) =>
      set((state) => {
        const normalizedSelection = getNormalizedSelectionState(
          state.tasks,
          state.projects,
          state.selectedProjectId,
          state.selectedTaskId,
          taskStatusFilter,
          state.taskScopeFilter,
        );

        return {
          taskStatusFilter,
          ...normalizedSelection,
        };
      }),
    setTaskDetailViewMode: (mode) => set({ taskDetailViewMode: mode }),
    setSearchQuery: (query) => set({ searchQuery: query }),
    toggleProjectVisibility: (projectId) =>
      set((state) => {
        const next = new Set(state.hiddenProjectIds);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        saveHiddenProjectIds(next);
        return { hiddenProjectIds: next };
      }),

    loadFromDB: () => {
      if (get().isLoaded) return Promise.resolve();
      initialLoad ??= refreshStoreFromDB(true).finally(() => {
        initialLoad = null;
      });
      return initialLoad;
    },

    reloadFromDB: async () => {
      await refreshStoreFromDB(false);
    },

    loadTransitionOptions: async (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      const cached = get().transitionOptions[taskId];
      if (cached && Date.now() - cached.fetchedAt < TRANSITION_CACHE_MS) return;
      const account = getAccountForTask(task, getJiraAccounts());
      if (!account) return;
      try {
        const statuses = await fetchJiraTransitionTargets(account, task.jiraTaskId);
        set((state) => ({
          transitionOptions: {
            ...state.transitionOptions,
            [taskId]: { statuses, fetchedAt: Date.now() },
          },
        }));
      } catch (error) {
        // Offline or no permission: the dropdown keeps offering every project status.
        console.warn(`Could not load transitions for ${task.jiraTaskId}:`, error);
      }
    },

    applySyncResult: (result) =>
      set((state) => {
        const accountIds = getJiraAccounts().map((account) => account.id);
        const removedTasks = new Set(result.removedTaskIds);
        const removedProjects = new Set(result.removedProjectIds);
        const archived = new Set(result.archivedTaskIds);

        const organizations = upsertById(state.organizations, result.organizations).sort(
          (left, right) => compareScopedEntityOrder(left.id, right.id, accountIds, "organization"),
        );
        const projects = upsertById(
          state.projects.filter((project) => !removedProjects.has(project.id)),
          result.projects,
        ).sort((left, right) => compareScopedEntityOrder(left.id, right.id, accountIds, "project"));
        const knownProjectIds = new Set(projects.map((project) => project.id));

        const tasks = upsertById(
          state.tasks
            .filter((task) => !removedTasks.has(task.id))
            .map((task) => (archived.has(task.id) ? { ...task, isArchived: true } : task)),
          result.tasks,
        ).filter((task) => knownProjectIds.has(task.projectId));

        const replacedLogTasks = new Set([...result.workLogTaskIds, ...result.removedTaskIds]);
        const workLogs = [
          ...state.workLogs.filter((workLog) => !replacedLogTasks.has(workLog.taskId)),
          ...result.workLogs,
        ];

        const changedTaskIds = new Set(result.tasks.map((task) => task.id));
        const transitionOptions = Object.fromEntries(
          Object.entries(state.transitionOptions).filter(([taskId]) => !changedTaskIds.has(taskId)),
        );

        return {
          organizations,
          projects,
          tasks,
          workLogs,
          aiBoardStates: upsertById(state.aiBoardStates, result.aiBoardStates ?? []),
          transitionOptions,
          ...getNormalizedSelectionState(
            tasks,
            projects,
            state.selectedProjectId,
            state.selectedTaskId,
            state.taskStatusFilter,
            state.taskScopeFilter,
          ),
        };
      }),

    updateTaskStatus: (taskId, status) => updateTask(taskId, { status }),
    updateTaskStoryLevel: (taskId, level) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      if (level !== null && task.type !== "Story") return;
      updateTask(taskId, { storyLevel: level });
    },
    updateTaskMandays: (taskId, mandays) => updateTask(taskId, { mandays }),
    updateTaskType: (taskId, type) => updateTask(taskId, { type }),
    updateTaskSeverity: (taskId, severity) => updateTask(taskId, { severity }),
    updateTaskRefUrl: (taskId, refUrl) => updateTask(taskId, { refUrl }),
    updateTaskNote: (taskId, note) =>
      set((state) => ({
        tasks: state.tasks.map((task) => {
          if (task.id !== taskId) return task;
          // Deliberately not markDirtyAndPersist: a note has nothing to push.
          const updated: Task = { ...task, note };
          persistTaskInBackground(updated);
          return updated;
        }),
      })),

    postNoteAsComment: async (taskId, text) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      const body = text.trim();
      if (!task) throw new Error("This ticket is no longer available");
      if (!body) throw new Error("Enter a comment before posting");
      const account = getAccountForTask(task, getJiraAccounts());
      if (!account) throw new Error("This ticket's Jira account is no longer configured");
      await addJiraComment(account, task.jiraTaskId, body);
    },

    addWorkLog: (log) =>
      runLocked(async () => {
        const task = getLatestTask(log.taskId);
        if (!task || !getAccountForTask(task, getJiraAccounts()))
          throw new Error("This ticket or its Jira account is no longer available");
        if (!Number.isSafeInteger(log.timeSpentMinutes) || log.timeSpentMinutes <= 0)
          throw new Error("Enter a positive number of minutes");
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(log.logDate) ||
          new Date(`${log.logDate}T00:00:00Z`).toISOString().slice(0, 10) !== log.logDate
        )
          throw new Error("Select a valid worklog date");
        const newLog: WorkLog = {
          ...log,
          id: `wl-${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          jiraWorklogId: null,
          syncStatus: "pending_create",
          isOwn: true,
        };
        let persistedTask = task;
        await db.transaction("rw", db.tasks, db.workLogs, async () => {
          await db.workLogs.put(newLog);
          const latest = getLatestTask(log.taskId);
          if (!latest || !getAccountForTask(latest, getJiraAccounts()))
            throw new Error("This ticket or its Jira account is no longer available");
          persistedTask = buildDirtyTask(latest, {});
          await db.tasks.put(persistedTask);
        });
        set((state) => {
          const latest = state.tasks.find((t) => t.id === log.taskId);
          const updated =
            latest && latest.updatedAt === task.updatedAt && latest.note === persistedTask.note
              ? persistedTask
              : latest
                ? markDirtyAndPersist(latest, {})
                : undefined;
          return {
            workLogs: [...state.workLogs, newLog],
            tasks: updated ? replaceTask(state.tasks, updated) : state.tasks,
          };
        });
      }),

    removeWorkLog: (logId) => {
      const log = get().workLogs.find((workLog) => workLog.id === logId);
      // Worklogs logged by teammates are read-only: deleting them would remove their time in Jira.
      if (!log || !isOwnWorkLog(log)) return;

      set((state) => {
        const task = state.tasks.find((t) => t.id === log.taskId);
        const tasks = task ? replaceTask(state.tasks, markDirtyAndPersist(task, {})) : state.tasks;

        if (isPendingCreateWorkLog(log)) {
          deleteWorkLogInBackground(logId);
          return { workLogs: removeWorkLog(state.workLogs, logId), tasks };
        }

        const pendingDeletedWorkLog: WorkLog = { ...log, syncStatus: "pending_delete" };
        persistWorkLogInBackground(pendingDeletedWorkLog);
        return { workLogs: replaceWorkLog(state.workLogs, pendingDeletedWorkLog), tasks };
      });
    },

    syncTaskToJira: (taskId) =>
      runLocked(async () => {
        const task = get().tasks.find((candidate) => candidate.id === taskId);
        if (!task?.isDirty) return;

        const syncedTask = await syncDirtyTask(task, getJiraAccounts(), getLatestTask);
        if (!syncedTask) return;

        const syncedWorkLogs = await db.workLogs.where("taskId").equals(task.id).toArray();
        set((state) => ({
          tasks: replaceTask(state.tasks, syncedTask),
          workLogs: replaceTaskWorkLogs(state.workLogs, task.id, syncedWorkLogs),
          transitionOptions: withoutKey(state.transitionOptions, task.id),
        }));
      }),

    syncAllDirtyTasks: () =>
      runLocked(async () => {
        const dirtyTasks = get().tasks.filter((task) => task.isDirty);
        if (dirtyTasks.length === 0) return;

        const accounts = getJiraAccounts();
        const settled = await Promise.allSettled(
          dirtyTasks.map((task) => syncDirtyTask(task, accounts, getLatestTask)),
        );

        const failures = collectTaskFailures(settled, dirtyTasks, "Sync");

        await get().reloadFromDB();
        set({ transitionOptions: {} });

        if (failures.length > 0) {
          const failedList = formatTaskFailures(failures);
          console.warn(`Some tasks failed to sync: ${failedList}`);
          throw new Error(`Some tasks failed to sync: ${failedList}`);
        }
      }),

    discardTask: (taskId) =>
      runLocked(async () => {
        const task = get().tasks.find((candidate) => candidate.id === taskId);
        if (!task?.isDirty) return;

        const restored = await discardDirtyTask(task, getJiraAccounts());
        if (!restored) return;

        const freshWorkLogs = await db.workLogs.where("taskId").equals(taskId).toArray();
        set((state) => ({
          tasks: replaceTask(state.tasks, restored),
          workLogs: replaceTaskWorkLogs(state.workLogs, taskId, freshWorkLogs),
          transitionOptions: withoutKey(state.transitionOptions, taskId),
        }));
      }),

    discardAllDirtyTasks: () =>
      runLocked(async () => {
        const dirtyTasks = get().tasks.filter((task) => task.isDirty);
        if (dirtyTasks.length === 0) return;

        const accounts = getJiraAccounts();
        const settled = await Promise.allSettled(
          dirtyTasks.map((task) => discardDirtyTask(task, accounts)),
        );

        const failures = collectTaskFailures(settled, dirtyTasks, "Discard");

        await get().reloadFromDB();
        set({ transitionOptions: {} });

        if (failures.length > 0) {
          const failedList = formatTaskFailures(failures);
          console.warn(`Some tasks failed to discard: ${failedList}`);
          throw new Error(`Some tasks failed to discard: ${failedList}`);
        }
      }),

    getDirtyTaskCount: () => get().tasks.filter((task) => task.isDirty).length,

    getFilteredTasks: () => {
      const {
        tasks,
        selectedProjectId,
        taskStatusFilter,
        searchQuery,
        hiddenProjectIds,
        taskScopeFilter,
      } = get();
      return filterTasks(
        tasks,
        selectedProjectId,
        taskStatusFilter,
        searchQuery,
        hiddenProjectIds,
        taskScopeFilter,
      );
    },

    getVisibleProjects: () => {
      const { projects, tasks, taskStatusFilter, taskScopeFilter } = get();
      const visibleProjectIds = getVisibleProjectIds(
        tasks,
        projects,
        taskStatusFilter,
        taskScopeFilter,
      );
      return projects.filter((project) => visibleProjectIds.has(project.id));
    },

    getStatusesForProject: (projectId) => {
      const project = get().projects.find((candidate) => candidate.id === projectId);
      return project?.availableStatuses ?? [];
    },

    getWorkLogsForTask: (taskId) =>
      getVisibleWorkLogsForTask(get().workLogs, taskId).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),

    getTaskById: (taskId) => get().tasks.find((task) => task.id === taskId),
    getProjectById: (projectId) => get().projects.find((project) => project.id === projectId),
    getTotalTimeForTask: (taskId) =>
      getVisibleWorkLogsForTask(get().workLogs, taskId)
        .filter(isCountedWorkLog)
        .reduce((sum, workLog) => sum + workLog.timeSpentMinutes, 0),
  };
});
