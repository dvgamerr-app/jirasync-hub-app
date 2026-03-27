import { create } from "zustand";
import { Organization, Project, Task, WorkLog, StoryLevel, TaskType, Severity } from "@/types/jira";
import { db, getJiraAccounts, getStoryPointFieldMap, type JiraAccount } from "@/lib/jira-db";
import {
  getAccountIdFromTask,
  isOrganizationIdForAccounts,
  isProjectIdForAccounts,
  isTaskIdForAccounts,
} from "@/lib/jira-ids";
import {
  updateJiraIssue,
  transitionJiraIssue,
  addJiraWorkLog,
  deleteJiraWorkLog,
} from "@/lib/jira-api";
import {
  isPendingCreateWorkLog,
  isPendingDeleteWorkLog,
  isVisibleWorkLog,
  toSyncedWorkLog,
} from "@/lib/worklog-sync";

export type TaskStatusFilter = "active" | "done" | "all";

interface TaskStore {
  organizations: Organization[];
  projects: Project[];
  tasks: Task[];
  workLogs: WorkLog[];
  isLoaded: boolean;

  selectedProjectId: string | null;
  selectedTaskId: string | null;
  taskStatusFilter: TaskStatusFilter;
  taskDetailViewMode: "details" | "description";

  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;
  setTaskStatusFilter: (filter: TaskStatusFilter) => void;
  setTaskDetailViewMode: (mode: "details" | "description") => void;

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
  const storyPointFieldId = storyPointFieldMap[task.projectId] ?? "customfield_10016";

  const fields: Record<string, unknown> = {};
  // Always send the story point field — null clears it in Jira
  fields[storyPointFieldId] = task.storyLevel ?? null;
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
  // Internal store: mandays is a decimal where 1 = 1 manday = 8 hours
  if (typeof task.mandays === "number" && !isNaN(task.mandays)) {
    const totalMinutes = Math.round(task.mandays * 8 * 60);
    const seconds = totalMinutes * 60;

    // Build human-readable string like "1d 4h 30m" (1d = 8h)
    const days = Math.floor(totalMinutes / 480);
    const hours = Math.floor((totalMinutes % 480) / 60);
    const mins = totalMinutes % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    const estimateStr = parts.join(" ") || "0m";

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
  if (task.status) {
    await transitionJiraIssue(account, task.jiraTaskId, task.status).catch(() => {
      // transition may fail if status name doesn't match — non-fatal
    });
  }
}

function logStoreError(message: string, error: unknown): void {
  console.error(message, error);
}

async function persistTask(task: Task): Promise<void> {
  await db.tasks.put(task);
}

function persistTaskInBackground(task: Task): void {
  void persistTask(task).catch((error) => {
    logStoreError(`Failed to persist task ${task.id}:`, error);
  });
}

function persistWorkLogInBackground(workLog: WorkLog): void {
  void db.workLogs.put(workLog).catch((error) => {
    logStoreError(`Failed to persist worklog ${workLog.id}:`, error);
  });
}

function deleteWorkLogInBackground(workLogId: string): void {
  void db.workLogs.delete(workLogId).catch((error) => {
    logStoreError(`Failed to delete worklog ${workLogId}:`, error);
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

  const [allOrganizations, allProjects, allTasks, allWorkLogs] = await Promise.all([
    db.organizations.toArray(),
    db.projects.toArray(),
    db.tasks.toArray(),
    db.workLogs.toArray(),
  ]);

  const organizations = allOrganizations.filter((org) =>
    isOrganizationIdForAccounts(org.id, accountIds),
  );
  const projects = allProjects.filter((project) => isProjectIdForAccounts(project.id, accountIds));
  const visibleProjectIds = new Set(projects.map((project) => project.id));
  const tasks = allTasks.filter(
    (task) => isTaskIdForAccounts(task.id, accountIds) && visibleProjectIds.has(task.projectId),
  );
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const workLogs = allWorkLogs.filter((workLog) => visibleTaskIds.has(workLog.taskId));

  return {
    organizations,
    projects,
    tasks,
    workLogs,
  };
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

function isDoneTask(task: Pick<Task, "status">): boolean {
  return task.status?.trim().toLowerCase() === "done";
}

function matchesTaskStatusFilter(
  task: Pick<Task, "status">,
  taskStatusFilter: TaskStatusFilter,
): boolean {
  switch (taskStatusFilter) {
    case "done":
      return isDoneTask(task);
    case "active":
      return !isDoneTask(task);
    case "all":
    default:
      return true;
  }
}

function getVisibleTasks(
  tasks: Task[],
  selectedProjectId: string | null,
  taskStatusFilter: TaskStatusFilter,
): Task[] {
  const filteredByProject = selectedProjectId
    ? tasks.filter((task) => task.projectId === selectedProjectId)
    : tasks;

  return filteredByProject.filter((task) => matchesTaskStatusFilter(task, taskStatusFilter));
}

function getVisibleProjectIds(
  tasks: Task[],
  projects: Project[],
  taskStatusFilter: TaskStatusFilter,
): Set<string> {
  const knownProjectIds = new Set(projects.map((project) => project.id));

  return new Set(
    tasks
      .filter(
        (task) =>
          knownProjectIds.has(task.projectId) && matchesTaskStatusFilter(task, taskStatusFilter),
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
): Pick<TaskStore, "selectedProjectId" | "selectedTaskId"> {
  const visibleProjectIds = getVisibleProjectIds(tasks, projects, taskStatusFilter);
  const nextSelectedProjectId =
    selectedProjectId && !visibleProjectIds.has(selectedProjectId) ? null : selectedProjectId;
  const visibleTaskIds = new Set(
    getVisibleTasks(tasks, nextSelectedProjectId, taskStatusFilter).map((task) => task.id),
  );

  return {
    selectedProjectId: nextSelectedProjectId,
    selectedTaskId: selectedTaskId && !visibleTaskIds.has(selectedTaskId) ? null : selectedTaskId,
  };
}

function markDirty(task: Task, updates: Partial<Task>): Task {
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

function toSyncedTask(task: Task): Task {
  return { ...task, isDirty: false, isSynced: true };
}

async function persistSyncedTask(task: Task): Promise<Task> {
  const synced = toSyncedTask(task);
  await persistTask(synced);
  return synced;
}

async function syncTaskWorkLogsToJira(task: Task, account: JiraAccount): Promise<void> {
  const taskWorkLogs = await db.workLogs.where("taskId").equals(task.id).toArray();

  for (const workLog of taskWorkLogs.filter(isPendingCreateWorkLog)) {
    const jiraWorklogId = await addJiraWorkLog(
      account,
      task.jiraTaskId,
      workLog.timeSpentMinutes,
      workLog.logDate,
      workLog.comment,
    );

    if (!jiraWorklogId) {
      throw new Error(`Failed creating worklog for ${task.jiraTaskId}`);
    }

    await db.workLogs.put(toSyncedWorkLog(workLog, jiraWorklogId));
  }

  for (const workLog of taskWorkLogs.filter(isPendingDeleteWorkLog)) {
    if (workLog.jiraWorklogId) {
      await deleteJiraWorkLog(account, task.jiraTaskId, workLog.jiraWorklogId);
    }

    await db.workLogs.delete(workLog.id);
  }
}

async function syncDirtyTask(task: Task, accounts: JiraAccount[]): Promise<void> {
  const account = getAccountForTask(task, accounts);
  if (!account) return;

  await pushTaskToJira(task, accounts);
  await syncTaskWorkLogsToJira(task, account);
  await persistSyncedTask(task);
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
        task.id === taskId ? markDirty(task, updates) : task,
      );
      const normalizedSelection = getNormalizedSelectionState(
        tasks,
        state.projects,
        state.selectedProjectId,
        state.selectedTaskId,
        state.taskStatusFilter,
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
    taskStatusFilter: "active",
    taskDetailViewMode: "details",

    setSelectedProject: (projectId) => set({ selectedProjectId: projectId, selectedTaskId: null }),
    setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),
    setTaskStatusFilter: (taskStatusFilter) =>
      set((state) => {
        const normalizedSelection = getNormalizedSelectionState(
          state.tasks,
          state.projects,
          state.selectedProjectId,
          state.selectedTaskId,
          taskStatusFilter,
        );

        return {
          taskStatusFilter,
          ...normalizedSelection,
        };
      }),
    setTaskDetailViewMode: (mode) => set({ taskDetailViewMode: mode }),

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
        id: `wl-${Date.now()}`,
        createdAt: new Date().toISOString(),
        jiraWorklogId: null,
        syncStatus: "pending_create",
      };
      persistWorkLogInBackground(newLog);
      set((state) => ({ workLogs: [...state.workLogs, newLog] }));

      // Mark parent task dirty so row turns yellow and sync button activates.
      const task = get().tasks.find((candidate) => candidate.id === log.taskId);
      if (!task) return;

      const dirtyTask = markDirty(task, {});
      set((state) => ({ tasks: replaceTask(state.tasks, dirtyTask) }));
    },

    removeWorkLog: (logId) => {
      const log = get().workLogs.find((workLog) => workLog.id === logId);
      if (!log) return;

      if (isPendingCreateWorkLog(log)) {
        deleteWorkLogInBackground(logId);
        set((state) => ({ workLogs: removeWorkLog(state.workLogs, logId) }));
      } else {
        const pendingDeletedWorkLog: WorkLog = { ...log, syncStatus: "pending_delete" };
        persistWorkLogInBackground(pendingDeletedWorkLog);
        set((state) => ({
          workLogs: replaceWorkLog(state.workLogs, pendingDeletedWorkLog),
        }));
      }

      // Keep the parent task dirty so the delete waits for manual push sync.
      const task = get().tasks.find((candidate) => candidate.id === log.taskId);
      if (task) {
        const dirtyTask = markDirty(task, {});
        set((state) => ({ tasks: replaceTask(state.tasks, dirtyTask) }));
      }
    },

    syncTaskToJira: async (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      if (!task || !task.isDirty) return;

      await syncDirtyTask(task, getJiraAccounts());
      await get().reloadFromDB();
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
        const failedList = failures.map((failure) => failure.jiraId).join(", ");
        console.warn(`Some tasks failed to sync: ${failedList}`);
        throw new Error(`Some tasks failed to sync: ${failedList}`);
      }
    },

    getDirtyTaskCount: () => get().tasks.filter((task) => task.isDirty).length,

    getFilteredTasks: () => {
      const { tasks, selectedProjectId, taskStatusFilter } = get();
      const filtered = getVisibleTasks(tasks, selectedProjectId, taskStatusFilter);
      return [...filtered].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      );
    },

    getVisibleProjects: () => {
      const { projects, tasks, taskStatusFilter } = get();
      const visibleProjectIds = getVisibleProjectIds(tasks, projects, taskStatusFilter);
      return projects.filter((project) => visibleProjectIds.has(project.id));
    },

    getStatusesForProject: (projectId) => {
      const project = get().projects.find((candidate) => candidate.id === projectId);
      return project?.availableStatuses ?? [];
    },

    getWorkLogsForTask: (taskId) =>
      get()
        .workLogs.filter((workLog) => workLog.taskId === taskId && isVisibleWorkLog(workLog))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),

    getTaskById: (taskId) => get().tasks.find((task) => task.id === taskId),
    getProjectById: (projectId) => get().projects.find((project) => project.id === projectId),
    getTotalTimeForTask: (taskId) =>
      get()
        .workLogs.filter((workLog) => workLog.taskId === taskId && isVisibleWorkLog(workLog))
        .reduce((sum, workLog) => sum + workLog.timeSpentMinutes, 0),
  };
});
