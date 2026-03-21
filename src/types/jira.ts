export interface Organization {
  id: string;
  name: string;
  jiraInstanceUrl: string;
  lastSyncedAt: string | null;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  jiraProjectKey: string;
  availableStatuses: string[];
}

export interface Task {
  id: string;
  projectId: string;
  jiraTaskId: string;
  title: string;
  description: string | null;
  status: string | null;
  storyLevel: 1 | 2 | 3 | 5 | null;
  mandays: number | null;
  assignee: string | null;
  isSynced: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkLog {
  id: string;
  taskId: string;
  timeSpentMinutes: number;
  logDate: string;
  comment: string | null;
  createdAt: string;
}

export type StoryLevel = 1 | 2 | 3 | 5;
