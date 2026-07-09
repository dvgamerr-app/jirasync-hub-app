import type { KanbanColumn, KanbanJiraLinkType, KanbanPriority } from "@/types/kanban";

/** Seeded once into kanbanDb.columns when the table is empty — not a live source of truth. */
export const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
  { id: "todo", label: "To Do", order: 0 },
  { id: "in_progress", label: "In Progress", order: 1 },
  { id: "waiting", label: "Waiting", order: 2 },
  { id: "blocked", label: "Blocked", order: 3 },
  { id: "done", label: "Done", order: 4 },
];

/**
 * Column ids that can never be deleted — they're the stable anchors an MCP client can
 * rely on to know what state a card is in, regardless of whatever custom columns the
 * user adds around them. Renaming and reordering are still allowed.
 */
export const LOCKED_KANBAN_COLUMN_IDS: string[] = ["todo", "in_progress", "waiting", "done"];

export const KANBAN_PRIORITIES: KanbanPriority[] = ["low", "medium", "high"];

export const KANBAN_PRIORITY_LABELS: Record<KanbanPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export const KANBAN_JIRA_LINK_TYPES: KanbanJiraLinkType[] = [
  "relates_to",
  "blocks",
  "is_blocked_by",
  "duplicates",
];

export const KANBAN_JIRA_LINK_TYPE_LABELS: Record<KanbanJiraLinkType, string> = {
  relates_to: "Relates to",
  blocks: "Blocks",
  is_blocked_by: "Is blocked by",
  duplicates: "Duplicates",
};
