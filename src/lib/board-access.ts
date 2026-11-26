// What external MCP clients may see when the owner turns on board access: tasks in the AI
// Board To Do column whose project is bound to a repository, not completed in Jira, with the
// same snapshot as Copy for AI and never the local note.
import { invoke } from "@tauri-apps/api/core";
import { getAiBoardStatus, type AiBoardTaskState } from "@/lib/ai-board";
import { buildAiContext } from "@/lib/ai-context";
import { getAccountIdFromTask } from "@/lib/jira-ids";
import { listenNative, type AgentProvider, type RepoBinding } from "@/lib/harness";
import type { Task } from "@/types/jira";

export interface BoardTask {
  taskId: string;
  projectId: string;
  issueKey: string;
  title: string;
  context: string;
}

export interface BoardRunRequest {
  requestId: string;
  taskId: string;
  issueKey: string;
  provider: AgentProvider;
  note: string;
  status: "pending" | "approved" | "declined";
  createdAt: number;
}

export interface BoardAccess {
  expiresAt: number;
  /** MCP client config with the board token; only returned when access is granted. */
  mcpConfig?: unknown;
}

export const BOARD_ACCESS_HOURS = [1, 4, 8, 24] as const;
export const BOARD_REQUEST_EVENT = "harness://board-request";

export function readyBoardTasks(
  tasks: Task[],
  aiStates: AiBoardTaskState[],
  bindings: RepoBinding[],
): BoardTask[] {
  const bound = new Set(bindings.map((binding) => binding.projectId));
  const states = new Map(aiStates.map((state) => [state.id, state]));
  return tasks
    .filter((task) => bound.has(task.projectId))
    .filter((task) => getAiBoardStatus(task, states.get(task.id)) === "todo")
    .map((task) => ({
      taskId: task.id,
      projectId: task.projectId,
      issueKey: task.jiraTaskId,
      title: task.title,
      context: buildAiContext(task, {
        parent: tasks.find(
          (candidate) =>
            candidate.jiraTaskId === task.parentKey &&
            getAccountIdFromTask(candidate) === getAccountIdFromTask(task),
        ),
        includeNote: false,
      }),
    }));
}

export const enableBoardAccess = (hours: number) =>
  invoke<BoardAccess>("harness_board_enable", { hours });
export const disableBoardAccess = () => invoke<void>("harness_board_disable");
export const boardAccessExpiry = () => invoke<number | null>("harness_board_status");
export const publishBoardTasks = (tasks: BoardTask[]) =>
  invoke<void>("harness_board_publish", { tasks });
export const listBoardRequests = () => invoke<BoardRunRequest[]>("harness_board_requests");
export const resolveBoardRequest = (requestId: string, approve: boolean) =>
  invoke<BoardRunRequest>("harness_board_resolve", { requestId, approve });

export const onBoardRequest = (handler: (request: BoardRunRequest) => void) =>
  listenNative<BoardRunRequest>(BOARD_REQUEST_EVENT, handler);
