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

/** Task fields a user can edit locally and that are pushed back to Jira. */
/** "note" is legacy only: the note is local-only now and never becomes dirty. */
export type DirtyField =
  "status" | "type" | "severity" | "storyLevel" | "mandays" | "note" | "refUrl";

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
  isCreatedByCurrentUser?: boolean | null;
  refUrl: string | null;
  note: string | null;
  isArchived?: boolean;
  isSynced: boolean;
  isDirty: boolean;
  /**
   * Which fields were edited since the last push. Only these are sent to Jira, and only these
   * survive a pull. `undefined` on a dirty task means a legacy record: treat every field as dirty.
   */
  dirtyFields?: DirtyField[];
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
  /** Jira display name of whoever logged this time (set for Jira-sourced worklogs). */
  authorName?: string | null;
  /**
   * `false` when the worklog was logged by someone other than the connected Jira user.
   * `null`/`undefined` means "yours or unknown" and is counted as yours.
   */
  isOwn?: boolean | null;
}

export type StoryLevel = 1 | 2 | 3 | 5;
export type WorkLogSyncStatus = "synced" | "pending_create" | "pending_delete";
