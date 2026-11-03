// Typed client for the native harness core (src-tauri/src/harness). Only typed commands with
// validated inputs cross the bridge; the WebView never sends a command line to execute.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const COMMAND_NAMES = ["install", "build", "test", "lint", "dev"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CommandSpec {
  executable: string;
  args: string[];
}

export type RepoCommands = Partial<Record<CommandName, CommandSpec | null>>;

export interface ToolCheck {
  name: string;
  required: boolean;
  purpose: string;
  path: string | null;
  version: string | null;
  ok: boolean;
  detail: string | null;
}

export interface DockerCheck {
  context: string | null;
  endpoint: string | null;
  serverVersion: string | null;
  ok: boolean;
  detail: string | null;
}

export interface DoctorReport {
  tools: ToolCheck[];
  docker: DockerCheck;
  ready: boolean;
  checkedAt: number;
}

export interface RepoDetection {
  root: string;
  remoteUrl: string | null;
  defaultBranch: string;
  ecosystem: string | null;
  commands: RepoCommands;
  envFiles: string[];
  envExampleFile: string | null;
  missingEnvKeys: string[];
  serviceEnvKeys: string[];
  composeFiles: string[];
  notes: string[];
  missingExecutables: string[];
}

export interface RepoBinding {
  projectId: string;
  repoPath: string;
  baseBranch: string;
  worktreeRoot: string;
  commands: RepoCommands;
  copyEnv: string[];
  updatedAt: number;
}

export const harnessDoctor = () => invoke<DoctorReport>("harness_doctor");
export const detectRepo = (path: string) => invoke<RepoDetection>("harness_detect_repo", { path });
export const defaultWorktreeRoot = (repoPath: string) =>
  invoke<string>("harness_default_worktree_root", { repoPath });
export const listRepoBindings = () => invoke<RepoBinding[]>("harness_list_bindings");
export const saveRepoBinding = (binding: RepoBinding) =>
  invoke<RepoBinding>("harness_save_binding", { binding });
export const deleteRepoBinding = (projectId: string) =>
  invoke<void>("harness_delete_binding", { projectId });

export type RunStatus =
  | "preparing"
  | "installing"
  | "planning"
  | "awaiting_plan"
  | "running"
  | "verifying"
  | "ready_for_review"
  | "publishing"
  | "completed"
  | "prepared"
  | "finished"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "prepared",
  "finished",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Nothing runs; the run waits for an owner decision (it does not block other runs). */
export const WAITING_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "awaiting_plan",
  "ready_for_review",
]);

/** A process of the run may be running right now (only one such run at a time). */
export function isRunBusy(status: RunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.has(status) && !WAITING_RUN_STATUSES.has(status);
}

export type RunDecision = "approve_plan" | "revise_plan" | "request_changes" | "accept";

export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  logId: string;
  durationMs: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  copiedEnv: string[];
  missingEnv: string[];
}

export interface RunRecord {
  runId: string;
  taskId: string;
  projectId: string;
  issueKey: string;
  repoPath: string;
  status: RunStatus;
  worktree: WorktreeInfo | null;
  worktreeRemoved: boolean;
  createdAt: number;
  endedAt: number | null;
  error: string | null;
  /** "agent" when a coding agent works on the task, "prepare" for a workspace only. */
  mode: "agent" | "prepare" | "";
  sessionId: string | null;
  plan: string | null;
  /** Agent working time in ms (time the app spent executing is not counted). */
  aiMs: number;
  attempts: number;
  checks: CheckResult[];
  changedFiles: string[];
  progress: string | null;
  copyEnv: string[];
  baseBranch: string;
  jiraUrl: string | null;
  verifiedDigest: string | null;
  /** The Draft PR the app opened when the owner accepted. */
  prUrl: string | null;
  /** Marked ready for review after CI passed. */
  prReady: boolean;
}

export type RunEventKind =
  | { type: "status"; status: RunStatus; message: string | null }
  | { type: "step_start"; step: string; command: string }
  | { type: "output"; step: string; stream: "stdout" | "stderr"; text: string }
  | { type: "step_end"; step: string; exitCode: number | null; durationMs: number }
  | { type: "permission"; tool: string; decision: "allow" | "deny" }
  | {
      type: "agent";
      kind: "init" | "text" | "tool" | "plan" | "pr_draft" | "result";
      text: string;
    };

export type RunEvent = { runId: string; seq: number; at: number } & RunEventKind;

/** Live run output from the native journal (it is written to disk before it is sent). */
export const RUN_EVENT = "harness://run-event";

/** `context` (the task snapshot as markdown) starts a coding agent; without it, only prepare. */
export const startRun = (
  taskId: string,
  projectId: string,
  issueKey: string,
  context: string | null,
  jiraUrl: string | null = null,
) => invoke<RunRecord>("harness_start_run", { taskId, projectId, issueKey, context, jiraUrl });
export const resumeRun = (runId: string, decision: RunDecision, feedback?: string) =>
  invoke<RunRecord>("harness_resume_run", { runId, decision, feedback: feedback ?? null });
export const stopRun = (runId: string) => invoke<void>("harness_stop_run", { runId });
export const listRuns = () => invoke<RunRecord[]>("harness_list_runs");
export const getRunEvents = (runId: string, afterSeq: number) =>
  invoke<RunEvent[]>("harness_run_events", { runId, afterSeq });
export const removeRunWorktree = (runId: string, discardChanges: boolean) =>
  invoke<RunRecord>("harness_remove_run_worktree", { runId, discardChanges });

/** Subscribes to live run events; returns an unsubscribe function. */
export function onRunEvent(handler: (event: RunEvent) => void): () => void {
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void listen<RunEvent>(RUN_EVENT, (event) => handler(event.payload))
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch(() => {
      // Plain-browser preview has no event bridge; runs are unavailable there.
    });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** `bun run test`, quoting arguments that contain spaces. */
export function formatCommand(command: CommandSpec | null | undefined): string {
  if (!command) return "";
  return [command.executable, ...command.args]
    .map((part) => (/\s/.test(part) || part === "" ? `"${part}"` : part))
    .join(" ");
}

/** Splits `bun run "my script"` into an executable + args. Empty text means "no command". */
export function parseCommand(text: string): CommandSpec | null {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of text.trim()) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) throw new Error(`Unclosed quote in "${text}"`);
  if (started) parts.push(current);
  const [executable, ...args] = parts;
  return executable ? { executable, args } : null;
}

/** Max run events kept in memory per run; the full journal stays on disk. */
export const RUN_EVENT_CAP = 2000;

/**
 * Merges journal events by sequence number: duplicates are dropped, order is restored, and
 * only the newest `cap` events are kept. Safe to call with replayed and live events mixed.
 */
export function mergeRunEvents(
  current: RunEvent[],
  incoming: RunEvent[],
  cap = RUN_EVENT_CAP,
): RunEvent[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Page size of `harness_run_events` when no limit is passed (matches the native default). */
export const RUN_EVENT_PAGE = 2000;

/**
 * Where an agent run puts its task on the AI Board: working → Doing, waiting for review →
 * Review, accepted → Done. Other statuses (stopped, failed) leave the board as it is.
 */
export function aiBoardStatusForRun(status: RunStatus): "doing" | "review" | "done" | null {
  if (status === "ready_for_review" || status === "publishing") return "review";
  if (status === "completed") return "done";
  if (
    ["preparing", "installing", "planning", "awaiting_plan", "running", "verifying"].includes(
      status,
    )
  )
    return "doing";
  return null;
}

export interface CiStatus {
  checks: { name: string; bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" }[];
  /** At least one check and none pending or failing. */
  allPassed: boolean;
}

export const getPrChecks = (runId: string) => invoke<CiStatus>("harness_pr_checks", { runId });
/** Draft → ready for review; the native core refuses unless CI passed. */
export const markPrReady = (runId: string) => invoke<RunRecord>("harness_mark_pr_ready", { runId });
