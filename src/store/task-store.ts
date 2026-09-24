import { create } from "zustand";
import { Organization, Project, Task, WorkLog, StoryLevel, TaskType, Severity } from "@/types/jira";
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
  deleteJiraWorkLog,
  fetchFreshJiraTask,
} from "@/lib/jira-api";
import {
  isPendingCreateWorkLog,
  isPendingDeleteWorkLog,
  isVisibleWorkLog,
  toSyncedWorkLog,
} from "@/lib/worklog-sync";
import { formatMandayEstimate } from "@/lib/worklog-time";
import { getErrorMessage } from "@/lib/utils";

function getVisibleWorkLogsForTask(workLogs: WorkLog[], taskId: string): WorkLog[] {
  return workLogs.filter((wl) => wl.taskId === taskId && isVisibleWorkLog(wl));
}

export type TaskStatusFilter = "active" | "done" | "all";
export type TaskScopeFilter = "my-work" | "created-by-me";

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
  searchQuery: string;
  hiddenProjectIds: Set<string>;

  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;
  setTaskScopeFilter: (filter: TaskScopeFilter) => void;
  setTaskStatusFilter: (filter: TaskStatusFilter) => void;
  setTaskDetailViewMode: (mode: "details" | "description") => void;
  setSearchQuery: (query: string) => void;
  toggleProjectVisibility: (projectId: string) => void;

  loadFromDB: () => Promise<void>;
  reloadFromDB: () => Promise<void>;

  updateTaskStatus: (taskId: string, status: string) => void;
  updateTaskStoryLevel: (taskId: string, level: StoryLevel | null) => void;
  updateTaskMandays: (taskId: string, mandays: number | null) => void;
  updateTaskType: (taskId: string, type: TaskType | null) => void;
  updateTaskSeverity: (taskId: string, severity: Severity | null) => void;
  updateTaskRefUrl: (taskId: string, refUrl: string | null) => void;
  updateTaskNote: (taskId: string, note: string | null) => void;

  addWorkLog: (log: Omit<WorkLog, "id" | "createdAt">) => void;
  removeWorkLog: (logId: string) => void;

  syncTaskToJira: (taskId: string) => Promise<void>;
  syncAllDirtyTasks: () => Promise<void>;
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

export const INACTIVE_STATUSES = new Set(["done", "closed", "cancelled", "cancel", "canceled"]);

type ScopedTaskCollections = Pick<TaskStore, "organizations" | "projects" | "tasks" | "workLogs">;

function getAccountForTask(task: Task, accounts: JiraAccount[]): JiraAccount | undefined {
  const accountId = getAccountIdFromTask(task);
  if (!accountId) return undefined;
  return accounts.find((a) => a.id === accountId);
}

async function pushTaskToJira(task: Task, accounts: JiraAccount[]): Promise<void> {
  const account = getAccountForTask(task, accounts);
  if (!account) return;

  const storyPointFieldMap = getStoryPointFieldMap();
  const storyPointFieldId = storyPointFieldMap[task.projectId];

  const fields: Record<string, unknown> = {};
  // Only send the story point field when this project has one mapped in Jira
  // Settings — guessing the default field id makes Jira reject the whole
  // update (400) for projects where that field isn't on the edit screen.
  if (storyPointFieldId) {
    fields[storyPointFieldId] = task.storyLevel ?? null;
  }
  if (task.severity && task.severity !== "NA" && SEVERITY_TO_PRIORITY[task.severity]) {
    fields.priority = { name: SEVERITY_TO_PRIORITY[task.severity] };
  }
  if (task.note !== null) {
    fields.description = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: task.note }] }],
    };
  }

  // If mandays set, convert to Jira timetracking originalEstimate
  if (typeof task.mandays === "number" && !isNaN(task.mandays)) {
    const { str: estimateStr, seconds } = formatMandayEstimate(task.mandays);
    fields.timetracking = {
      originalEstimate: estimateStr,
      originalEstimateSeconds: seconds,
    };
  }

  try {
    await updateJiraIssue(account, task.jiraTaskId, fields);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed updating issue ${task.jiraTaskId}:`, err);
    throw new Error(`Failed updating ${task.jiraTaskId}: ${message}`, { cause: err });
  }

  if (task.status) {
    await transitionJiraIssue(account, task.jiraTaskId, task.status).catch((err: unknown) => {
      console.warn(`Transition failed for ${task.jiraTaskId} → "${task.status}":`, err);
    });
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

function replaceWorkLog(workLogs: WorkLog[], nextWorkLog: WorkLog): WorkLog[] {
  return workLogs.map((workLog) => (workLog.id === nextWorkLog.id ? nextWorkLog : workLog));
}

function removeWorkLog(workLogs: WorkLog[], workLogId: string): WorkLog[] {
  return workLogs.filter((workLog) => workLog.id !== workLogId);
}

function formatTaskFailures(failures: { jiraId: string; reason: unknown }[]): string {
  return failures.map((failure) => `${failure.jiraId} (${getErrorMessage(failure.reason)})`).join("; ");
}

function isDoneTask(task: Pick<Task, "status" | "statusCategory">): boolean {
  return (
    task.statusCategory === "done" || INACTIVE_STATUSES.has(task.status?.trim().toLowerCase() ?? "")
  );
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

  return filteredByProject.filter(
    (task) =>
      matchesTaskScope(task, taskScopeFilter) &&
      ((taskScopeFilter === "my-work" && task.isEpic === true) ||
        matchesTaskStatusFilter(task, taskStatusFilter, taskScopeFilter)),
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
        task.description?.toLowerCase().includes(normalizedQuery),
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

  return new Set(
    tasks
      .filter(
        (task) =>
          knownProjectIds.has(task.projectId) &&
          matchesTaskScope(task, taskScopeFilter) &&
          matchesTaskStatusFilter(task, taskStatusFilter, taskScopeFilter),
      )
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

function markDirtyAndPersist(task: Task, updates: Partial<Task>): Task {
  const updated = {
    ...task,
    ...updates,
    isDirty: true,
    isSynced: false,
    updatedAt: new Date().toISOString(),
  };
  persistTaskInBackground(updated);
  return updated;
}

async function persistSyncedTask(task: Task): Promise<Task> {
  const synced: Task = { ...task, isDirty: false, isSynced: true };
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

async function syncDirtyTask(task: Task, accounts: JiraAccount[]): Promise<Task | null> {
  const account = getAccountForTask(task, accounts);
  if (!account) return null;

  await pushTaskToJira(task, accounts);
  await syncTaskWorkLogsToJira(task, account);
  return persistSyncedTask(task);
}

async function replaceTaskWorkLogsWithFresh(taskId: string, freshWorkLogs: WorkLog[]): Promise<void> {
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
  const restored: Task = { ...freshTask, isArchived: task.isArchived };
  await persistTask(restored);
  await replaceTaskWorkLogsWithFresh(task.id, freshWorkLogs);
  return restored;
}

const HIDDEN_PROJECTS_KEY = "jirasync-hidden-projects";

function loadHiddenProjectIds(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_PROJECTS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveHiddenProjectIds(ids: Set<string>): void {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...ids]));
}

export const useTaskStore = create<TaskStore>((set, get) => {
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
    searchQuery: "",
    hiddenProjectIds: loadHiddenProjectIds(),

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

    loadFromDB: async () => {
      await refreshStoreFromDB(true);
    },

    reloadFromDB: async () => {
      await refreshStoreFromDB(false);
    },

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
    updateTaskNote: (taskId, note) => updateTask(taskId, { note }),

    addWorkLog: (log) => {
      const newLog: WorkLog = {
        ...log,
        id: `wl-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        jiraWorklogId: null,
        syncStatus: "pending_create",
      };
      persistWorkLogInBackground(newLog);
      set((state) => {
        const task = state.tasks.find((t) => t.id === log.taskId);
        return {
          workLogs: [...state.workLogs, newLog],
          tasks: task ? replaceTask(state.tasks, markDirtyAndPersist(task, {})) : state.tasks,
        };
      });
    },

    removeWorkLog: (logId) => {
      const log = get().workLogs.find((workLog) => workLog.id === logId);
      if (!log) return;

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

    syncTaskToJira: async (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      if (!task || !task.isDirty) return;

      const syncedTask = await syncDirtyTask(task, getJiraAccounts());
      if (!syncedTask) return;

      const syncedWorkLogs = await db.workLogs.where("taskId").equals(task.id).toArray();
      set((state) => ({
        tasks: replaceTask(state.tasks, syncedTask),
        workLogs: [
          ...state.workLogs.filter((workLog) => workLog.taskId !== task.id),
          ...syncedWorkLogs,
        ],
      }));
    },

    syncAllDirtyTasks: async () => {
      const dirtyTasks = get().tasks.filter((task) => task.isDirty);
      if (dirtyTasks.length === 0) return;

      const accounts = getJiraAccounts();
      const settled = await Promise.allSettled(
        dirtyTasks.map((task) => syncDirtyTask(task, accounts)),
      );

      const failures: { jiraId: string; reason: unknown }[] = [];
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          failures.push({
            jiraId: dirtyTasks[index].jiraTaskId,
            reason: result.reason,
          });
          console.error(`Sync failed for ${dirtyTasks[index].jiraTaskId}:`, result.reason);
        }
      });

      await get().reloadFromDB();

      if (failures.length > 0) {
        const failedList = formatTaskFailures(failures);
        console.warn(`Some tasks failed to sync: ${failedList}`);
        throw new Error(`Some tasks failed to sync: ${failedList}`);
      }
    },

    discardAllDirtyTasks: async () => {
      const dirtyTasks = get().tasks.filter((task) => task.isDirty);
      if (dirtyTasks.length === 0) return;

      const accounts = getJiraAccounts();
      const settled = await Promise.allSettled(
        dirtyTasks.map((task) => discardDirtyTask(task, accounts)),
      );

      const failures: { jiraId: string; reason: unknown }[] = [];
      settled.forEach((result, index) => {
        if (result.status === "rejected") {
          failures.push({
            jiraId: dirtyTasks[index].jiraTaskId,
            reason: result.reason,
          });
          console.error(`Discard failed for ${dirtyTasks[index].jiraTaskId}:`, result.reason);
        }
      });

      await get().reloadFromDB();

      if (failures.length > 0) {
        const failedList = formatTaskFailures(failures);
        console.warn(`Some tasks failed to discard: ${failedList}`);
        throw new Error(`Some tasks failed to discard: ${failedList}`);
      }
    },

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
      getVisibleWorkLogsForTask(get().workLogs, taskId).reduce(
        (sum, workLog) => sum + workLog.timeSpentMinutes,
        0,
      ),
  };
});
