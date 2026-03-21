import { create } from "zustand";
import { Organization, Project, Task, WorkLog, StoryLevel, TaskType, Severity } from "@/types/jira";
import { db, getJiraAccounts, type JiraAccount } from "@/lib/jira-db";
import { mockOrganizations, mockProjects, mockTasks, mockWorkLogs } from "@/data/mock-data";
import { updateJiraIssue, transitionJiraIssue, addJiraWorkLog, deleteJiraWorkLog } from "@/lib/jira-api";

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
  const prefix = task.id.replace(`task-`, "").replace(`-${task.jiraTaskId}`, "");
  // task id format: task-{accountId}-{issueKey}
  // issueKey can contain hyphens e.g. PROJ-123, so extract by removing known parts
  const accountId = task.id.slice("task-".length, task.id.length - task.jiraTaskId.length - 1);
  return accounts.find((a) => a.id === accountId);
}

async function pushTaskToJira(task: Task, accounts: JiraAccount[]): Promise<void> {
  const account = getAccountForTask(task, accounts);
  if (!account) return;

  const fields: Record<string, any> = {};
  if (task.storyLevel !== null) fields.customfield_10016 = task.storyLevel;
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

  if (Object.keys(fields).length > 0) {
    await updateJiraIssue(account, task.jiraTaskId, fields);
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
    const hasAccounts = accounts.length > 0;
    const taskCount = await db.tasks.count();

    if (hasAccounts && taskCount > 0) {
      // Load from IndexedDB — filter to only tasks/projects belonging to current accounts
      const accountIds: string[] = accounts.map((a: JiraAccount) => a.id);
      const [organizations, projects, allTasks, workLogs] = await Promise.all([
        db.organizations.toArray(),
        db.projects.toArray(),
        db.tasks.toArray(),
        db.workLogs.toArray(),
      ]);
      const tasks = allTasks.filter((t: Task) => accountIds.some((id: string) => t.id.startsWith(`task-${id}-`)));
      set({ organizations, projects, tasks, workLogs, isLoaded: true });
    } else if (!hasAccounts) {
      // No Jira configured — use mock data
      set({
        organizations: mockOrganizations,
        projects: mockProjects,
        tasks: mockTasks,
        workLogs: mockWorkLogs,
        isLoaded: true,
      });
    } else {
      // Jira configured but no data yet — empty state, sync will populate
      set({ organizations: [], projects: [], tasks: [], workLogs: [], isLoaded: true });
    }
  },

  reloadFromDB: async () => {
    const accountIds: string[] = getJiraAccounts().map((a: JiraAccount) => a.id);
    const [organizations, projects, allTasks, workLogs] = await Promise.all([
      db.organizations.toArray(),
      db.projects.toArray(),
      db.tasks.toArray(),
      db.workLogs.toArray(),
    ]);
    const tasks = allTasks.filter((t: Task) => accountIds.some((id: string) => t.id.startsWith(`task-${id}-`)));
    set({ organizations, projects, tasks, workLogs });
  },

  updateTaskStatus: (taskId, status) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { status }) : t),
    })),

  updateTaskStoryLevel: (taskId, level) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { storyLevel: level }) : t),
    })),

  updateTaskMandays: (taskId, mandays) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { mandays }) : t),
    })),

  updateTaskType: (taskId, type) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { type }) : t),
    })),

  updateTaskSeverity: (taskId, severity) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { severity }) : t),
    })),

  updateTaskRefUrl: (taskId, refUrl) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { refUrl }) : t),
    })),

  updateTaskNote: (taskId, note) =>
    set((state) => ({
      tasks: state.tasks.map((t) => t.id === taskId ? markDirty(t, { note }) : t),
    })),

  addWorkLog: (log) => {
    const newLog: WorkLog = { ...log, id: `wl-${Date.now()}`, createdAt: new Date().toISOString(), jiraWorklogId: null };
    db.workLogs.put(newLog).catch(console.error);
    set((state) => ({ workLogs: [...state.workLogs, newLog] }));

    // Push to Jira in background, then store the returned Jira worklog ID
    const task = get().tasks.find((t) => t.id === log.taskId);
    if (task) {
      const account = getAccountForTask(task, getJiraAccounts());
      if (account) {
        addJiraWorkLog(account, task.jiraTaskId, log.timeSpentMinutes, log.logDate, log.comment)
          .then(async (jiraId: string | null | undefined) => {
            if (jiraId) {
              const updated = { ...newLog, jiraWorklogId: jiraId };
              await db.workLogs.put(updated);
              set((state) => ({
                workLogs: state.workLogs.map((wl) => wl.id === newLog.id ? updated : wl),
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

    // Delete from Jira in background if we have the Jira worklog ID
    if (log?.jiraWorklogId) {
      const task = get().tasks.find((t) => t.id === log.taskId);
      if (task) {
        const account = getAccountForTask(task, getJiraAccounts());
        if (account) {
          deleteJiraWorkLog(account, task.jiraTaskId, log.jiraWorklogId).catch(console.error);
        }
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
    set((state) => ({ tasks: state.tasks.map((t) => t.id === taskId ? synced : t) }));
  },

  syncAllDirtyTasks: async () => {
    const dirtyTasks = get().tasks.filter((t) => t.isDirty);
    if (dirtyTasks.length === 0) return;
    const accounts = getJiraAccounts();
    const settled = await Promise.allSettled(dirtyTasks.map((t) => pushTaskToJira(t, accounts)));
    const syncedIds = new Set(
      dirtyTasks.filter((_, i) => settled[i].status === "fulfilled").map((t) => t.id),
    );
    const updatedTasks = get().tasks.map((t) => {
      if (!syncedIds.has(t.id)) return t;
      const synced = { ...t, isDirty: false, isSynced: true };
      db.tasks.put(synced).catch(console.error);
      return synced;
    });
    set({ tasks: updatedTasks });
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
    get().workLogs.filter((wl) => wl.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  getTaskById: (taskId) => get().tasks.find((t) => t.id === taskId),
  getProjectById: (projectId) => get().projects.find((p) => p.id === projectId),
  getTotalTimeForTask: (taskId) =>
    get().workLogs.filter((wl) => wl.taskId === taskId).reduce((sum, wl) => sum + wl.timeSpentMinutes, 0),
}));
