import type { BoardRunRequest, BoardTask } from "@/lib/board-access";
// Replaces @tauri-apps/api/core in e2e mode. Credentials are "encrypted" with a
// reversible, non-secret encoding so the real encrypt/decrypt call sites still run.
// Harness commands answer from window.__e2e.harness (see state.ts) and record every call.
import type { RepoBinding, RunEvent, RunRecord } from "@/lib/harness";
import { emptyRunRecord, getHarnessState } from "./state";
import { emit } from "./tauri-event";

/** Appends to the fake journal and sends it live, like the native core does. */
function pushRunEvent(event: RunEvent) {
  const state = getHarnessState();
  state.journal ??= {};
  (state.journal[event.runId] ??= []).push(event);
  if (event.type === "status") {
    const { status, message } = event;
    state.runs = (state.runs ?? []).map((run) =>
      run.runId === event.runId ? { ...run, status, error: message ?? run.error } : run,
    );
  }
  emit("harness://run-event", event);
}

declare global {
  interface Window {
    __e2ePushRunEvent?: (event: RunEvent) => void;
  }
}
window.__e2ePushRunEvent = pushRunEvent;

function runCommand(cmd: string, args?: Record<string, unknown>): unknown {
  const state = getHarnessState();
  const runs = (state.runs ??= []);
  switch (cmd) {
    case "harness_start_run": {
      const active = runs.find((run) =>
        ["preparing", "installing", "planning", "running", "verifying"].includes(run.status),
      );
      if (active) throw `another run (${active.runId}) is active; stop it or wait for it to finish`;
      if (!state.bindings.some((binding) => binding.projectId === args?.projectId))
        throw "bind this project to a repository in Setup first";
      const record: RunRecord = {
        ...emptyRunRecord(),
        runId: `run${String(runs.length + 1).padStart(3, "0")}abc`,
        taskId: String(args?.taskId),
        projectId: String(args?.projectId),
        issueKey: String(args?.issueKey),
        repoPath: "C:/src/service",
        createdAt: Date.now(),
        mode: args?.context ? "agent" : "prepare",
        provider: args?.context ? (args?.provider === "codex" ? "codex" : "claude") : "",
      };
      state.runs = [record, ...runs];
      pushRunEvent({
        runId: record.runId,
        seq: 1,
        at: Date.now(),
        type: "status",
        status: "preparing",
        message: null,
      });
      return record;
    }
    case "harness_resume_run": {
      // The real gate rules are tested natively; the shim records the decision and moves on.
      const run = runs.find((candidate) => candidate.runId === args?.runId);
      if (!run) throw `run ${args?.runId} not found`;
      if (["revise_plan", "request_changes"].includes(String(args?.decision)) && !args?.feedback)
        throw "write what should change";
      const status =
        args?.decision === "accept"
          ? "publishing"
          : args?.decision === "revise_plan"
            ? "planning"
            : "running";
      state.runs = runs.map((candidate) =>
        candidate === run ? { ...candidate, status } : candidate,
      );
      return state.runs.find((candidate) => candidate.runId === run.runId);
    }
    case "harness_pr_checks":
      return state.ci ?? { checks: [], allPassed: false };
    case "harness_mark_pr_ready": {
      if (!state.ci?.allPassed) throw "CI has not passed yet";
      state.runs = runs.map((run) => (run.runId === args?.runId ? { ...run, prReady: true } : run));
      return state.runs.find((run) => run.runId === args?.runId);
    }
    case "harness_stop_run":
      return null;
    case "harness_list_runs":
      return runs;
    case "harness_run_events":
      return (state.journal?.[String(args?.runId)] ?? []).filter(
        (event) => event.seq > Number(args?.afterSeq ?? 0),
      );
    case "harness_remove_run_worktree": {
      const runId = String(args?.runId);
      if (state.dirtyWorktrees?.includes(runId) && !args?.discardChanges)
        throw "worktree has 1 uncommitted change(s); confirm to discard them";
      state.runs = runs.map((run) =>
        run.runId === runId ? { ...run, worktreeRemoved: true } : run,
      );
      return state.runs.find((run) => run.runId === runId);
    }
    default:
      return undefined;
  }
}

function harness(cmd: string, args?: Record<string, unknown>): unknown {
  const state = getHarnessState();
  state.calls.push({ cmd, args });
  switch (cmd) {
    case "harness_doctor":
      return state.doctor;
    case "harness_detect_repo": {
      const result = state.detections[String(args?.path)];
      if (result === undefined) throw `${args?.path} is not inside a git repository`;
      if (typeof result === "string") throw result;
      return result;
    }
    case "harness_default_worktree_root":
      return "C:\\wt";
    case "harness_list_bindings":
      return state.bindings;
    case "harness_save_binding": {
      const binding = { ...(args?.binding as RepoBinding), updatedAt: Date.now() };
      state.bindings = [
        ...state.bindings.filter((existing) => existing.projectId !== binding.projectId),
        binding,
      ];
      return binding;
    }
    case "harness_delete_binding":
      state.bindings = state.bindings.filter((binding) => binding.projectId !== args?.projectId);
      return null;
    default:
      if (cmd.startsWith("harness_snapshot_")) return snapshotCommand(cmd, args);
      return cmd.startsWith("harness_board_") ? boardCommand(cmd, args) : runCommand(cmd, args);
  }
}

// Git snapshot sync: `remote` is what the sync folder holds after a pull; pushes are kept.
function snapshotCommand(cmd: string, args?: Record<string, unknown>): unknown {
  const sync = (getHarnessState().snapshot ??= { remote: null, pushed: [] });
  if (sync.busy) throw "run abc123 is working; finish or stop it before syncing to another machine";
  if (cmd === "harness_snapshot_pull") return sync.remote;
  const content = String(args?.content);
  const committed = content !== sync.remote;
  sync.pushed.push(content);
  sync.remote = content;
  return { committed, pushed: committed };
}

// Board access: the published tasks and requests stay in state so tests can play the external
// MCP client (window.__e2eBoardRequest) and read back what the app published.
function boardCommand(cmd: string, args?: Record<string, unknown>): unknown {
  const state = getHarnessState();
  const board = (state.board ??= { expiresAt: null, tasks: [], requests: [] });
  switch (cmd) {
    case "harness_board_enable":
      board.expiresAt = Date.now() + Number(args?.hours) * 3_600_000;
      board.requests = [];
      return {
        expiresAt: board.expiresAt,
        mcpConfig: { mcpServers: { harness: { type: "http", url: "http://127.0.0.1:1/mcp" } } },
      };
    case "harness_board_disable":
      board.expiresAt = null;
      board.tasks = [];
      return null;
    case "harness_board_status":
      return board.expiresAt;
    case "harness_board_publish":
      if (!board.expiresAt) throw "board access is off";
      board.tasks = args?.tasks as BoardTask[];
      return null;
    case "harness_board_requests":
      return board.requests;
    case "harness_board_resolve": {
      const request = board.requests.find((r) => r.requestId === args?.requestId);
      if (!request) throw "this request no longer exists";
      if (request.status !== "pending") throw `this request was already ${request.status}`;
      request.status = args?.approve ? "approved" : "declined";
      return { ...request };
    }
  }
}

declare global {
  interface Window {
    __e2eBoardRequest?: (taskId: string, provider: "claude" | "codex", note?: string) => void;
  }
}

/** Plays an external MCP client calling runs_request on a published ready task. */
window.__e2eBoardRequest = (taskId, provider, note = "") => {
  const board = getHarnessState().board;
  const task = board?.tasks.find((candidate) => candidate.taskId === taskId);
  if (!board?.expiresAt || !task) throw new Error("task is not published as ready");
  const request: BoardRunRequest = {
    requestId: `req-${board.requests.length + 1}`,
    taskId,
    issueKey: task.issueKey,
    provider,
    note,
    status: "pending",
    createdAt: Date.now(),
  };
  board.requests.push(request);
  emit("harness://board-request", { ...request });
};

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "encrypt_data") return btoa(encodeURIComponent(String(args?.plaintext))) as T;
  if (cmd === "decrypt_data") return decodeURIComponent(atob(String(args?.ciphertext))) as T;
  if (cmd.startsWith("harness_")) return harness(cmd, args) as T;
  throw new Error(`e2e: unmocked tauri command "${cmd}"`);
}
