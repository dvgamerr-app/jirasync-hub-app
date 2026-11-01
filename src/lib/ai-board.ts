import type { Task } from "@/types/jira";
import { getAccountIdFromTask } from "@/lib/jira-ids";

export const AI_BOARD_COLUMNS = [
  { id: "todo", label: "To Do" },
  { id: "doing", label: "Doing" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
] as const;
export type AiBoardStatus = (typeof AI_BOARD_COLUMNS)[number]["id"];
export interface AiBoardTaskState {
  /** The account-scoped Jira task ID. */
  id: string;
  accountId: string;
  status: AiBoardStatus;
  jiraDone: boolean;
  updatedAt: string;
}

export const DONE_TASK_STATUSES = new Set(["done", "closed", "cancelled", "cancel", "canceled"]);

export function isJiraDone(task: Pick<Task, "status" | "statusCategory">): boolean {
  return (
    task.statusCategory === "done" ||
    DONE_TASK_STATUSES.has(task.status?.trim().toLowerCase() ?? "")
  );
}

export function isAiBoardStatus(value: unknown): value is AiBoardStatus {
  return AI_BOARD_COLUMNS.some((column) => column.id === value);
}

export function isAiBoardCompletedByJira(task: Task, state?: AiBoardTaskState): boolean {
  return (
    isJiraDone(task) ||
    (state?.id === task.id &&
      state.accountId === getAccountIdFromTask(task) &&
      state.jiraDone === true)
  );
}

export function getAiBoardStatus(task: Task, state?: AiBoardTaskState): AiBoardStatus {
  if (isAiBoardCompletedByJira(task, state)) return "done";
  return state?.id === task.id &&
    state.accountId === getAccountIdFromTask(task) &&
    isAiBoardStatus(state.status)
    ? state.status
    : "todo";
}
