import { create } from "zustand";
import { Organization, Project, Task, WorkLog, StoryLevel, TaskType, Severity } from "@/types/jira";
import { db, getJiraAccounts, type JiraAccount } from "@/lib/jira-db";
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

  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;

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

/** Extract accountId from task id `task-{accountId}-{issueKey}` */
function getAccountForTask(task: Task, accounts: JiraAccount[]): JiraAccount | undefined {
  // task id format: task-{accountId}-{issueKey}
  // issueKey can contain hyphens e.g. PROJ-123, so extract by removing known parts
  const accountId = task.id.slice("task-".length, task.id.length - task.jiraTaskId.length - 1);
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

function markDirty(task: Task, updates: Partial<Task>): Task {
  const updated = { ...task, ...updates, isDirty: true, updatedAt: new Date().toISOString() };
  // Persist to IndexedDB
  db.tasks.put(updated).catch(console.error);
  return updated;
}

function isOrganizationForAccounts(orgId: string, accountIds: string[]): boolean {
  return accountIds.some((id) => orgId === `org-${id}`);
}

function isProjectForAccounts(projectId: string, accountIds: string[]): boolean {
  return accountIds.some((id) => projectId.startsWith(`proj-${id}-`));
}

function isTaskForAccounts(taskId: string, accountIds: string[]): boolean {
  return accountIds.some((id) => taskId.startsWith(`task-${id}-`));
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  organizations: [],
  projects: [],
  tasks: [],
  workLogs: [],
  isLoaded: false,

  selectedProjectId: null,
  selectedTaskId: null,

  setSelectedProject: (projectId) => set({ selectedProjectId: projectId, selectedTaskId: null }),
  setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),

  loadFromDB: async () => {
    const accounts = getJiraAccounts();
    const accountIds: string[] = accounts.map((a: JiraAccount) => a.id);

    if (accountIds.length === 0) {
      set({
        organizations: [],
        projects: [],
        tasks: [],
        workLogs: [],
        isLoaded: true,
      });
      return;
    }

    const [allOrganizations, allProjects, allTasks, allWorkLogs] = await Promise.all([
      db.organizations.toArray(),
      db.projects.toArray(),
      db.tasks.toArray(),
      db.workLogs.toArray(),
    ]);

    const organizations = allOrganizations.filter((org: Organization) =>
      isOrganizationForAccounts(org.id, accountIds),
    );
    const projects = allProjects.filter((project: Project) =>
      isProjectForAccounts(project.id, accountIds),
    );
    const tasks = allTasks.filter((task: Task) => isTaskForAccounts(task.id, accountIds));
    const workLogs = allWorkLogs.filter((workLog: WorkLog) =>
      isTaskForAccounts(workLog.taskId, accountIds),
    );

    set({ organizations, projects, tasks, workLogs, isLoaded: true });
  },

  reloadFromDB: async () => {
    const accountIds: string[] = getJiraAccounts().map((a: JiraAccount) => a.id);
    const [allOrganizations, allProjects, allTasks, allWorkLogs] = await Promise.all([
      db.organizations.toArray(),
      db.projects.toArray(),
      db.tasks.toArray(),
      db.workLogs.toArray(),
    ]);

    const organizations = allOrganizations.filter((org: Organization) =>
      isOrganizationForAccounts(org.id, accountIds),
    );
    const projects = allProjects.filter((project: Project) =>
      isProjectForAccounts(project.id, accountIds),
    );
    const tasks = allTasks.filter((task: Task) => isTaskForAccounts(task.id, accountIds));
    const workLogs = allWorkLogs.filter((workLog: WorkLog) =>
      isTaskForAccounts(workLog.taskId, accountIds),
    );

    set({ organizations, projects, tasks, workLogs });
  },

  updateTaskStatus: (taskId, status) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { status }) : t)),
    })),

  updateTaskStoryLevel: (taskId, level) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { storyLevel: level }) : t)),
    })),

  updateTaskMandays: (taskId, mandays) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { mandays }) : t)),
    })),

  updateTaskType: (taskId, type) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { type }) : t)),
    })),

  updateTaskSeverity: (taskId, severity) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { severity }) : t)),
    })),

  updateTaskRefUrl: (taskId, refUrl) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { refUrl }) : t)),
    })),

  updateTaskNote: (taskId, note) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? markDirty(t, { note }) : t)),
    })),

  addWorkLog: (log) => {
    const newLog: WorkLog = {
      ...log,
      id: `wl-${Date.now()}`,
      createdAt: new Date().toISOString(),
      jiraWorklogId: null,
    };
    db.workLogs.put(newLog).catch(console.error);
    set((state) => ({ workLogs: [...state.workLogs, newLog] }));

    // Mark parent task dirty so row turns yellow and sync button activates
    const task = get().tasks.find((t) => t.id === log.taskId);
    if (task) {
      const dirtyTask = markDirty(task, {});
      set((state) => ({ tasks: state.tasks.map((t) => (t.id === task.id ? dirtyTask : t)) }));

      const account = getAccountForTask(task, getJiraAccounts());
      if (account) {
        addJiraWorkLog(account, task.jiraTaskId, log.timeSpentMinutes, log.logDate, log.comment)
          .then(async (jiraId: string | null | undefined) => {
            if (jiraId) {
              const updated = { ...newLog, jiraWorklogId: jiraId };
              await db.workLogs.put(updated);
              set((state) => ({
                workLogs: state.workLogs.map((wl) => (wl.id === newLog.id ? updated : wl)),
              }));
            }
            // Clear dirty now that Jira confirmed
            const current = get().tasks.find((t) => t.id === log.taskId);
            if (current && current.isDirty) {
              const synced = { ...current, isDirty: false, isSynced: true };
              await db.tasks.put(synced);
              set((state) => ({
                tasks: state.tasks.map((t) => (t.id === synced.id ? synced : t)),
              }));
            }
          })
          .catch(console.error);
      }
    }
  },

  removeWorkLog: (logId) => {
    const log = get().workLogs.find((wl) => wl.id === logId);
    db.workLogs.delete(logId).catch(console.error);
    set((state) => ({ workLogs: state.workLogs.filter((wl) => wl.id !== logId) }));

    // Mark parent task dirty while Jira delete is in flight
    const task = log ? get().tasks.find((t) => t.id === log.taskId) : undefined;
    if (task) {
      const dirtyTask = markDirty(task, {});
      set((state) => ({ tasks: state.tasks.map((t) => (t.id === task.id ? dirtyTask : t)) }));
    }

    // Delete from Jira in background if we have the Jira worklog ID
    if (log?.jiraWorklogId) {
      const jiraTask = get().tasks.find((t) => t.id === log.taskId);
      if (jiraTask) {
        const account = getAccountForTask(jiraTask, getJiraAccounts());
        if (account) {
          deleteJiraWorkLog(account, jiraTask.jiraTaskId, log.jiraWorklogId)
            .then(async () => {
              // Clear dirty once Jira confirms the delete
              const current = get().tasks.find((t) => t.id === log.taskId);
              if (current && current.isDirty) {
                const synced = { ...current, isDirty: false, isSynced: true };
                await db.tasks.put(synced);
                set((state) => ({
                  tasks: state.tasks.map((t) => (t.id === synced.id ? synced : t)),
                }));
              }
            })
            .catch(console.error);
        }
      }
    } else if (task) {
      // No Jira worklog id means it was local-only — clear dirty immediately
      const current = get().tasks.find((t) => t.id === task.id);
      if (current) {
        const synced = { ...current, isDirty: false };
        db.tasks.put(synced).catch(console.error);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === synced.id ? synced : t)) }));
      }
    }
  },

  syncTaskToJira: async (taskId) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task || !task.isDirty) return;
    const accounts = getJiraAccounts();
    await pushTaskToJira(task, accounts);
    const synced = { ...task, isDirty: false, isSynced: true };
    await db.tasks.put(synced);
    set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? synced : t)) }));
  },

  syncAllDirtyTasks: async () => {
    const dirtyTasks = get().tasks.filter((t) => t.isDirty);
    if (dirtyTasks.length === 0) return;
    const accounts = getJiraAccounts();
    const settled = await Promise.allSettled(dirtyTasks.map((t) => pushTaskToJira(t, accounts)));
    const syncedIds = new Set(
      dirtyTasks.filter((_, i) => settled[i].status === "fulfilled").map((t) => t.id),
    );

    // Collect failures for reporting
    const failures: { id: string; jiraId: string; reason: unknown }[] = [];
    settled.forEach((res, i) => {
      if (res.status === "rejected") {
        failures.push({
          id: dirtyTasks[i].id,
          jiraId: dirtyTasks[i].jiraTaskId,
          reason: res.reason,
        });
        console.error(`Sync failed for ${dirtyTasks[i].jiraTaskId}:`, res.reason);
      }
    });

    const updatedTasks = get().tasks.map((t) => {
      if (!syncedIds.has(t.id)) return t;
      const synced = { ...t, isDirty: false, isSynced: true };
      db.tasks.put(synced).catch(console.error);
      return synced;
    });
    set({ tasks: updatedTasks });

    if (failures.length > 0) {
      const failedList = failures.map((f) => f.jiraId).join(", ");
      console.warn(`Some tasks failed to sync: ${failedList}`);
      throw new Error(`Some tasks failed to sync: ${failedList}`);
    }
  },

  getDirtyTaskCount: () => get().tasks.filter((t) => t.isDirty).length,

  getFilteredTasks: () => {
    const { tasks, selectedProjectId } = get();
    if (selectedProjectId) return tasks.filter((t) => t.projectId === selectedProjectId);
    return tasks;
  },

  getStatusesForProject: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    return project?.availableStatuses ?? [];
  },
  getWorkLogsForTask: (taskId) =>
    get()
      .workLogs.filter((wl) => wl.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  getTaskById: (taskId) => get().tasks.find((t) => t.id === taskId),
  getProjectById: (projectId) => get().projects.find((p) => p.id === projectId),
  getTotalTimeForTask: (taskId) =>
    get()
      .workLogs.filter((wl) => wl.taskId === taskId)
      .reduce((sum, wl) => sum + wl.timeSpentMinutes, 0),
}));
