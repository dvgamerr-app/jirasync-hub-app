import { create } from "zustand";
import { Organization, Project, Task, WorkLog, StoryLevel, TaskType, Severity } from "@/types/jira";
import { mockOrganizations, mockProjects, mockTasks, mockWorkLogs } from "@/data/mock-data";

interface TaskStore {
  organizations: Organization[];
  projects: Project[];
  tasks: Task[];
  workLogs: WorkLog[];

  selectedProjectId: string | null;
  selectedTaskId: string | null;

  setSelectedProject: (projectId: string | null) => void;
  setSelectedTask: (taskId: string | null) => void;

  updateTaskStatus: (taskId: string, status: string) => void;
  updateTaskStoryLevel: (taskId: string, level: StoryLevel | null) => void;
  updateTaskMandays: (taskId: string, mandays: number | null) => void;
  updateTaskType: (taskId: string, type: TaskType | null) => void;
  updateTaskSeverity: (taskId: string, severity: Severity | null) => void;
  updateTaskRefUrl: (taskId: string, refUrl: string | null) => void;
  updateTaskNote: (taskId: string, note: string | null) => void;

  addWorkLog: (log: Omit<WorkLog, "id" | "createdAt">) => void;

  syncTaskToJira: (taskId: string) => void;
  syncAllDirtyTasks: () => void;
  getDirtyTaskCount: () => number;

  getFilteredTasks: () => Task[];
  getStatusesForProject: (projectId: string) => string[];
  getWorkLogsForTask: (taskId: string) => WorkLog[];
  getTaskById: (taskId: string) => Task | undefined;
  getProjectById: (projectId: string) => Project | undefined;
  getTotalTimeForTask: (taskId: string) => number;
}

function markDirty(task: Task, updates: Partial<Task>): Task {
  return { ...task, ...updates, isDirty: true, updatedAt: new Date().toISOString() };
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  organizations: mockOrganizations,
  projects: mockProjects,
  tasks: mockTasks,
  workLogs: mockWorkLogs,

  selectedProjectId: null,
  selectedTaskId: null,

  setSelectedProject: (projectId) => set({ selectedProjectId: projectId, selectedTaskId: null }),
  setSelectedTask: (taskId) => set({ selectedTaskId: taskId }),

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

  addWorkLog: (log) =>
    set((state) => ({
      workLogs: [
        ...state.workLogs,
        { ...log, id: `wl-${Date.now()}`, createdAt: new Date().toISOString() },
      ],
    })),

  syncTaskToJira: (taskId) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, isDirty: false, isSynced: true } : t
      ),
    })),

  syncAllDirtyTasks: () =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.isDirty ? { ...t, isDirty: false, isSynced: true } : t
      ),
    })),

  getDirtyTaskCount: () => get().tasks.filter((t) => t.isDirty).length,

  getFilteredTasks: () => {
    const { tasks, selectedProjectId } = get();
    if (selectedProjectId) {
      return tasks.filter((t) => t.projectId === selectedProjectId);
    }
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
