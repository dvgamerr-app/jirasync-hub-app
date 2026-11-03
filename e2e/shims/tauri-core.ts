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
          ? "completed"
          : args?.decision === "revise_plan"
            ? "planning"
            : "running";
      state.runs = runs.map((candidate) =>
        candidate === run ? { ...candidate, status } : candidate,
      );
      return state.runs.find((candidate) => candidate.runId === run.runId);
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
      return runCommand(cmd, args);
  }
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "encrypt_data") return btoa(encodeURIComponent(String(args?.plaintext))) as T;
  if (cmd === "decrypt_data") return decodeURIComponent(atob(String(args?.ciphertext))) as T;
  if (cmd.startsWith("harness_")) return harness(cmd, args) as T;
  throw new Error(`e2e: unmocked tauri command "${cmd}"`);
}
