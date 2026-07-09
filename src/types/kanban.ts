export type KanbanPriority = "low" | "medium" | "high";
export type KanbanCommentAuthor = "user" | "ai";
export type KanbanJiraLinkType = "relates_to" | "blocks" | "is_blocked_by" | "duplicates";

export interface KanbanColumn {
  id: string;
  label: string;
  order: number;
}

export interface KanbanJiraLink {
  /** Jira issue key, e.g. "ABC-123". */
  issueKey: string;
  type: KanbanJiraLinkType;
}

export interface KanbanComment {
  id: string;
  author: KanbanCommentAuthor;
  body: string;
  createdAt: string;
}

export interface KanbanCard {
  id: string;
  title: string;
  detail: string;
  /** References a KanbanColumn.id — not a fixed union, since columns are user-editable. */
  status: string;
  order: number;
  jiraLinks?: KanbanJiraLink[];
  startDate?: string;
  dueDate?: string;
  priority?: KanbanPriority;
  tags?: string[];
  comments: KanbanComment[];
  createdAt: string;
  updatedAt: string;
}
