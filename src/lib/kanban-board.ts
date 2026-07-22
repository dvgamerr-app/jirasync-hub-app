import { differenceInCalendarDays, isValid, parseISO, startOfDay } from "date-fns";
import type { KanbanCard, KanbanPriority } from "@/types/kanban";

export type KanbanBoardView = "all" | "attention" | "waiting" | "done";
export type KanbanPriorityFilter = "all" | KanbanPriority;
export type KanbanDueState = "none" | "overdue" | "today" | "due_soon" | "upcoming";

export interface KanbanBoardFilters {
  query: string;
  view: KanbanBoardView;
  priority: KanbanPriorityFilter;
}

export interface KanbanBoardOverview {
  total: number;
  open: number;
  done: number;
  waiting: number;
  blocked: number;
  overdue: number;
  dueSoon: number;
  highPriority: number;
  attention: number;
}

export interface KanbanColumnStats {
  total: number;
  overdue: number;
  dueSoon: number;
  highPriority: number;
}

const DUE_SOON_WINDOW_DAYS = 3;

function parseDateOnly(value?: string): Date | null {
  if (!value) return null;
  const parsed = parseISO(value);
  return isValid(parsed) ? startOfDay(parsed) : null;
}

export function getKanbanDueState(
  card: Pick<KanbanCard, "dueDate">,
  now: Date = new Date(),
): KanbanDueState {
  const dueDate = parseDateOnly(card.dueDate);
  if (!dueDate) return "none";

  const diffDays = differenceInCalendarDays(dueDate, startOfDay(now));
  if (diffDays < 0) return "overdue";
  if (diffDays === 0) return "today";
  if (diffDays <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "upcoming";
}

export function getKanbanCardPreview(detail: string): string {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rawPreview = lines.slice(1).join(" ");
  if (!rawPreview) return "";

  const normalized = rawPreview
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_>#~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= 140) return normalized;
  return `${normalized.slice(0, 139).trimEnd()}…`;
}

export function matchesKanbanFilters(
  card: KanbanCard,
  filters: KanbanBoardFilters,
  now: Date = new Date(),
): boolean {
  const query = filters.query.trim().toLowerCase();
  const dueState = getKanbanDueState(card, now);

  if (filters.priority !== "all" && card.priority !== filters.priority) return false;

  if (filters.view === "attention") {
    const needsAttention =
      card.status === "blocked" ||
      card.priority === "high" ||
      dueState === "overdue" ||
      dueState === "today" ||
      dueState === "due_soon";
    if (!needsAttention) return false;
  }

  if (filters.view === "waiting" && card.status !== "waiting") return false;
  if (filters.view === "done" && card.status !== "done") return false;

  if (!query) return true;

  const haystacks = [
    card.title,
    card.detail,
    card.status,
    ...(card.tags ?? []),
    ...(card.jiraLinks?.map((link) => link.issueKey) ?? []),
  ];

  return haystacks.some((value) => value.toLowerCase().includes(query));
}

export function getKanbanBoardOverview(
  cards: KanbanCard[],
  now: Date = new Date(),
): KanbanBoardOverview {
  return cards.reduce<KanbanBoardOverview>(
    (overview, card) => {
      const dueState = getKanbanDueState(card, now);
      const isOpen = card.status !== "done";
      const isWaiting = card.status === "waiting";
      const isBlocked = card.status === "blocked";
      const isOverdue = dueState === "overdue";
      const isDueSoon = dueState === "today" || dueState === "due_soon";
      const isHighPriority = card.priority === "high";
      const needsAttention = isBlocked || isOverdue || isDueSoon || isHighPriority;

      overview.total += 1;
      overview.open += isOpen ? 1 : 0;
      overview.done += card.status === "done" ? 1 : 0;
      overview.waiting += isWaiting ? 1 : 0;
      overview.blocked += isBlocked ? 1 : 0;
      overview.overdue += isOverdue ? 1 : 0;
      overview.dueSoon += isDueSoon ? 1 : 0;
      overview.highPriority += isHighPriority ? 1 : 0;
      overview.attention += needsAttention ? 1 : 0;
      return overview;
    },
    {
      total: 0,
      open: 0,
      done: 0,
      waiting: 0,
      blocked: 0,
      overdue: 0,
      dueSoon: 0,
      highPriority: 0,
      attention: 0,
    },
  );
}

export function getKanbanColumnStats(
  cards: KanbanCard[],
  now: Date = new Date(),
): KanbanColumnStats {
  return cards.reduce<KanbanColumnStats>(
    (stats, card) => {
      const dueState = getKanbanDueState(card, now);
      stats.total += 1;
      stats.highPriority += card.priority === "high" ? 1 : 0;
      stats.overdue += dueState === "overdue" ? 1 : 0;
      stats.dueSoon += dueState === "today" || dueState === "due_soon" ? 1 : 0;
      return stats;
    },
    { total: 0, overdue: 0, dueSoon: 0, highPriority: 0 },
  );
}
