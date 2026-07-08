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
  availableIssueTypes?: string[];
}

export type TaskType = string;
export type Severity = "Critical" | "High" | "Medium" | "Low" | "NA";
export type StatusCategory = "new" | "indeterminate" | "done";

export interface Task {
  id: string;
  projectId: string;
  jiraTaskId: string;
  title: string;
  description: string | null;
  status: string | null;
  type: TaskType | null;
  isEpic?: boolean;
  parentKey?: string | null;
  severity: Severity | null;
  storyLevel: StoryLevel | null;
  mandays: number | null;
  assignee: string | null;
  statusCategory?: StatusCategory | null;
  isCurrentAssignee?: boolean | null;
  refUrl: string | null;
  note: string | null;
  isArchived?: boolean;
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
  syncStatus?: WorkLogSyncStatus | null;
}

export type StoryLevel = 1 | 2 | 3 | 5;
export type WorkLogSyncStatus = "synced" | "pending_create" | "pending_delete";
