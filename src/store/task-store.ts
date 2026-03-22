import { create } from "zustand";
import { Organization, Project, Task, WorkLog, StoryLevel, TaskType, Severity } from "@/types/jira";
import { db, getJiraAccounts, type JiraAccount } from "@/lib/jira-db";
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

interface TaskStore {
  organizations: Organization[];
  projects: Project[];
  tasks: Task[];
  workLogs: WorkLog[];
  isLoaded: boolean;

  selectedProjectId: string | null;
  selectedTaskId: string | null;
  taskDetailViewMode: "details" | "description";

  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;
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
  const fields: Record<string, unknown> = {};
  // Always send customfield_10016 — null clears story points in Jira
  fields.customfield_10016 = task.storyLevel ?? null;
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
      throw new Error(`Failed updating ${task.jiraTaskId}: ${message}`);
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

export const useTaskStore = create<TaskStore>((set, get) => {
  const refreshStoreFromDB = async (markAsLoaded: boolean): Promise<void> => {
    const collections = await loadScopedCollections(getJiraAccounts().map((account) => account.id));
    const currentState = get();
    const visibleProjectIds = new Set(collections.projects.map((project) => project.id));
    const visibleTaskIds = new Set(collections.tasks.map((task) => task.id));

    set({
      ...collections,
      ...(markAsLoaded ? { isLoaded: true } : {}),
      ...(currentState.selectedProjectId && !visibleProjectIds.has(currentState.selectedProjectId)
        ? { selectedProjectId: null }
        : {}),
      ...(currentState.selectedTaskId && !visibleTaskIds.has(currentState.selectedTaskId)
        ? { selectedTaskId: null }
        : {}),
    });
  };

  const updateTask = (taskId: string, updates: Partial<Task>) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId ? markDirty(task, updates) : task)),
    }));
  };

  return {
    organizations: [],
    projects: [],
    tasks: [],
    workLogs: [],
    isLoaded: false,

    selectedProjectId: null,
    selectedTaskId: null,
    taskDetailViewMode: "details",

    setSelectedProject: (projectId) => set({ selectedProjectId: projectId, selectedTaskId: null }),
    setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),
    setTaskDetailViewMode: (mode) => set({ taskDetailViewMode: mode }),

    loadFromDB: async () => {
      await refreshStoreFromDB(true);
    },

    reloadFromDB: async () => {
      await refreshStoreFromDB(false);
    },

    updateTaskStatus: (taskId, status) => updateTask(taskId, { status }),
    updateTaskStoryLevel: (taskId, level) => updateTask(taskId, { storyLevel: level }),
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
      };
      persistWorkLogInBackground(newLog);
      set((state) => ({ workLogs: [...state.workLogs, newLog] }));

      // Mark parent task dirty so row turns yellow and sync button activates.
      const task = get().tasks.find((candidate) => candidate.id === log.taskId);
      if (!task) return;

      const dirtyTask = markDirty(task, {});
      set((state) => ({ tasks: replaceTask(state.tasks, dirtyTask) }));

      const account = getAccountForTask(task, getJiraAccounts());
      if (!account) return;

      addJiraWorkLog(account, task.jiraTaskId, log.timeSpentMinutes, log.logDate, log.comment)
        .then(async (jiraId) => {
          if (jiraId) {
            const updatedWorkLog = { ...newLog, jiraWorklogId: jiraId };
            await db.workLogs.put(updatedWorkLog);
            set((state) => ({
              workLogs: replaceWorkLog(state.workLogs, updatedWorkLog),
            }));
          }

          const current = get().tasks.find((candidate) => candidate.id === log.taskId);
          if (current?.isDirty) {
            const syncedTask = await persistSyncedTask(current);
            set((state) => ({ tasks: replaceTask(state.tasks, syncedTask) }));
          }
        })
        .catch((error) => {
          logStoreError(`Failed to add worklog for ${task.jiraTaskId}:`, error);
        });
    },

    removeWorkLog: (logId) => {
      const log = get().workLogs.find((workLog) => workLog.id === logId);
      deleteWorkLogInBackground(logId);
      set((state) => ({ workLogs: state.workLogs.filter((workLog) => workLog.id !== logId) }));

      // Mark parent task dirty while Jira delete is in flight.
      const task = log ? get().tasks.find((candidate) => candidate.id === log.taskId) : undefined;
      if (task) {
        const dirtyTask = markDirty(task, {});
        set((state) => ({ tasks: replaceTask(state.tasks, dirtyTask) }));
      }

      if (log?.jiraWorklogId) {
        const jiraTask = get().tasks.find((candidate) => candidate.id === log.taskId);
        if (!jiraTask) return;

        const account = getAccountForTask(jiraTask, getJiraAccounts());
        if (!account) return;

        deleteJiraWorkLog(account, jiraTask.jiraTaskId, log.jiraWorklogId)
          .then(async () => {
            const current = get().tasks.find((candidate) => candidate.id === log.taskId);
            if (current?.isDirty) {
              const syncedTask = await persistSyncedTask(current);
              set((state) => ({ tasks: replaceTask(state.tasks, syncedTask) }));
            }
          })
          .catch((error) => {
            logStoreError(
              `Failed to delete worklog ${log.jiraWorklogId} for ${jiraTask.jiraTaskId}:`,
              error,
            );
          });
      } else if (task) {
        // No Jira worklog id means it was local-only — clear dirty immediately.
        const current = get().tasks.find((candidate) => candidate.id === task.id);
        if (current) {
          const syncedTask = toSyncedTask(current);
          persistTaskInBackground(syncedTask);
          set((state) => ({ tasks: replaceTask(state.tasks, syncedTask) }));
        }
      }
    },

    syncTaskToJira: async (taskId) => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      if (!task || !task.isDirty) return;

      await pushTaskToJira(task, getJiraAccounts());
      const syncedTask = await persistSyncedTask(task);
      set((state) => ({ tasks: replaceTask(state.tasks, syncedTask) }));
    },

    syncAllDirtyTasks: async () => {
      const dirtyTasks = get().tasks.filter((task) => task.isDirty);
      if (dirtyTasks.length === 0) return;

      const accounts = getJiraAccounts();
      const settled = await Promise.allSettled(
        dirtyTasks.map((task) => pushTaskToJira(task, accounts)),
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

      const syncedTasks = dirtyTasks
        .filter((_, index) => settled[index].status === "fulfilled")
        .map(toSyncedTask);

      if (syncedTasks.length > 0) {
        await db.tasks.bulkPut(syncedTasks);
        const syncedTasksById = new Map(syncedTasks.map((task) => [task.id, task]));
        set((state) => ({
          tasks: state.tasks.map((task) => syncedTasksById.get(task.id) ?? task),
        }));
      }

      if (failures.length > 0) {
        const failedList = failures.map((failure) => failure.jiraId).join(", ");
        console.warn(`Some tasks failed to sync: ${failedList}`);
        throw new Error(`Some tasks failed to sync: ${failedList}`);
      }
    },

    getDirtyTaskCount: () => get().tasks.filter((task) => task.isDirty).length,

    getFilteredTasks: () => {
      const { tasks, selectedProjectId } = get();
      const filtered = selectedProjectId
        ? tasks.filter((task) => task.projectId === selectedProjectId)
        : tasks;
      return [...filtered].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      );
    },

    getStatusesForProject: (projectId) => {
      const project = get().projects.find((candidate) => candidate.id === projectId);
      return project?.availableStatuses ?? [];
    },

    getWorkLogsForTask: (taskId) =>
      get()
        .workLogs.filter((workLog) => workLog.taskId === taskId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),

    getTaskById: (taskId) => get().tasks.find((task) => task.id === taskId),
    getProjectById: (projectId) => get().projects.find((project) => project.id === projectId),
    getTotalTimeForTask: (taskId) =>
      get()
        .workLogs.filter((workLog) => workLog.taskId === taskId)
        .reduce((sum, workLog) => sum + workLog.timeSpentMinutes, 0),
  };
});
