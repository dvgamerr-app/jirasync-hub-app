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

export type TaskType = "Story" | "Bug" | "Task";
export type Severity = "Critical" | "High" | "Medium" | "Low" | "NA";

export interface Task {
  id: string;
  projectId: string;
  jiraTaskId: string;
  title: string;
  description: string | null;
  status: string | null;
  type: TaskType | null;
  severity: Severity | null;
  storyLevel: StoryLevel | null;
  mandays: number | null;
  assignee: string | null;
  refUrl: string | null;
  note: string | null;
  isSynced: boolean;
  isDirty: boolean;
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
  jiraWorklogId?: string | null;
}

export type StoryLevel = 1 | 2 | 3 | 5;
