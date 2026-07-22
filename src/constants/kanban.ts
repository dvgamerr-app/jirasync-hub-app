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

export interface KanbanColumnUiToken {
  cardAccent: string;
  cardSurface: string;
  columnDot: string;
  columnGradient: string;
  statusBadge: string;
}

export const DEFAULT_KANBAN_COLUMN_UI: KanbanColumnUiToken = {
  cardAccent: "bg-primary/70",
  cardSurface: "border-primary/15 bg-primary/5",
  columnDot: "bg-primary",
  columnGradient: "from-primary/12",
  statusBadge:
    "border-primary/20 bg-primary/10 text-primary dark:border-primary/25 dark:bg-primary/15",
};

export const KANBAN_COLUMN_UI: Record<string, KanbanColumnUiToken> = {
  todo: {
    cardAccent: "bg-slate-500",
    cardSurface: "border-slate-300/80 bg-slate-50/90 dark:border-slate-700/70 dark:bg-slate-950/40",
    columnDot: "bg-slate-500",
    columnGradient: "from-slate-500/12",
    statusBadge:
      "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200",
  },
  in_progress: {
    cardAccent: "bg-sky-500",
    cardSurface: "border-sky-300/80 bg-sky-50/90 dark:border-sky-800/70 dark:bg-sky-950/35",
    columnDot: "bg-sky-500",
    columnGradient: "from-sky-500/12",
    statusBadge:
      "border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-800 dark:bg-sky-950/70 dark:text-sky-200",
  },
  waiting: {
    cardAccent: "bg-amber-500",
    cardSurface:
      "border-amber-300/80 bg-amber-50/90 dark:border-amber-800/70 dark:bg-amber-950/35",
    columnDot: "bg-amber-500",
    columnGradient: "from-amber-500/12",
    statusBadge:
      "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-200",
  },
  blocked: {
    cardAccent: "bg-rose-500",
    cardSurface: "border-rose-300/80 bg-rose-50/90 dark:border-rose-800/70 dark:bg-rose-950/35",
    columnDot: "bg-rose-500",
    columnGradient: "from-rose-500/12",
    statusBadge:
      "border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-800 dark:bg-rose-950/70 dark:text-rose-200",
  },
  done: {
    cardAccent: "bg-emerald-500",
    cardSurface:
      "border-emerald-300/80 bg-emerald-50/90 dark:border-emerald-800/70 dark:bg-emerald-950/35",
    columnDot: "bg-emerald-500",
    columnGradient: "from-emerald-500/12",
    statusBadge:
      "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-200",
  },
};
