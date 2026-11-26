// Turns a run journal into what the AI Board shows: a conversation between the owner and the
// agent, the pipeline steps, and one line saying what the agent is doing right now.
import type { RunEvent, RunRecord, RunStatus } from "@/lib/harness";
import { isRunBusy } from "@/lib/harness";

/** Lines kept per command card; the full log stays in the journal on disk. */
const COMMAND_LINES = 200;

/** A command the app ran (install, checks, git), folded with its output. */
export type CommandItem = {
  kind: "command";
  seq: number;
  step: string;
  command: string;
  lines: { text: string; err: boolean }[];
  exitCode: number | null;
  durationMs: number | null;
  done: boolean;
};

export type Entry =
  | { kind: "agent"; seq: number; text: string }
  /** Consecutive tool calls, folded into one row. */
  | { kind: "tools"; seq: number; tools: string[] }
  | CommandItem
  | { kind: "notice"; seq: number; text: string; error: boolean };

/** One agent session (planning, implementing, reviewing…): what it did and said, in order. */
export type TurnItem = {
  kind: "turn";
  seq: number;
  label: string;
  entries: Entry[];
  done: boolean;
  failed: boolean;
  durationMs: number | null;
};

export type ConversationItem = Entry | TurnItem | { kind: "owner"; seq: number; text: string };

const TURN_LABEL: Partial<Record<RunStatus, string>> = {
  planning: "Planning",
  running: "Working on the change",
  reviewing: "Reviewing the change",
  publishing: "Writing the pull request",
};

export function buildConversation(events: readonly RunEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const open = new Map<string, CommandItem>();
  let turn: TurnItem | null = null;
  let label = "Working";
  // Inside an agent session everything it does belongs to that session.
  const push = (entry: Entry) => (turn ? turn.entries : items).push(entry);
  const last = () => (turn ? turn.entries : items).at(-1);
  for (const event of events) {
    switch (event.type) {
      case "step_start": {
        if (event.step === "agent") {
          turn = {
            kind: "turn",
            seq: event.seq,
            label,
            entries: [],
            done: false,
            failed: false,
            durationMs: null,
          };
          items.push(turn);
          break;
        }
        const item: CommandItem = {
          kind: "command",
          seq: event.seq,
          step: event.step,
          command: event.command,
          lines: [],
          exitCode: null,
          durationMs: null,
          done: false,
        };
        open.set(event.step, item);
        push(item);
        break;
      }
      case "output": {
        const item = open.get(event.step);
        if (item) {
          item.lines.push({ text: event.text, err: event.stream === "stderr" });
          if (item.lines.length > COMMAND_LINES) item.lines.shift();
        } else if (event.stream === "stderr") {
          push({ kind: "notice", seq: event.seq, text: event.text, error: true });
        }
        break;
      }
      case "step_end": {
        if (event.step === "agent" && turn) {
          turn.done = true;
          turn.failed = event.exitCode !== 0;
          turn.durationMs = event.durationMs;
          turn = null;
          break;
        }
        const item = open.get(event.step);
        if (item) {
          item.exitCode = event.exitCode;
          item.durationMs = event.durationMs;
          item.done = true;
          open.delete(event.step);
        }
        break;
      }
      case "permission":
        if (event.decision === "deny")
          push({ kind: "notice", seq: event.seq, text: `Blocked ${event.tool}`, error: true });
        break;
      case "status":
        label = TURN_LABEL[event.status] ?? label;
        if (event.message && ["failed", "cancelled", "interrupted"].includes(event.status))
          items.push({ kind: "notice", seq: event.seq, text: event.message, error: true });
        break;
      case "agent": {
        const previous = last();
        if (event.kind === "owner") items.push({ kind: "owner", seq: event.seq, text: event.text });
        else if (event.kind === "text" || event.kind === "external_report")
          push({ kind: "agent", seq: event.seq, text: event.text });
        else if (event.kind === "tool") {
          if (previous?.kind === "tools") previous.tools.push(event.text);
          else push({ kind: "tools", seq: event.seq, tools: [event.text] });
        } else if (event.kind === "notice") {
          // (plan and review submissions already show as the agent's tool calls)
          const fixing = /^(\w+) failed; the agent is fixing it$/.exec(event.text);
          if (fixing) label = `Fixing ${fixing[1]}`;
          push({ kind: "notice", seq: event.seq, text: event.text, error: false });
        } else if (event.kind === "command_set")
          push({
            kind: "notice",
            seq: event.seq,
            text: `Fixed the ${event.text.replace(": ", " command: ")}`,
            error: false,
          });
        break;
      }
    }
  }
  return items;
}

export type ToolKind = "read" | "search" | "edit" | "run" | "git" | "skill" | "submit" | "other";

/** What a tool call did, for its icon and for the summary of a group of calls. */
export function describeTool(text: string): { kind: ToolKind; verb: string; detail: string } {
  const space = text.indexOf(" ");
  const name = space < 0 ? text : text.slice(0, space);
  const detail = space < 0 ? "" : text.slice(space + 1);
  if (name === "Read") return { kind: "read", verb: "Read", detail };
  if (name === "Grep" || name === "Glob") return { kind: "search", verb: "Searched", detail };
  if (name === "Edit" || name === "Write" || name === "MultiEdit")
    return { kind: "edit", verb: name === "Write" ? "Wrote" : "Edited", detail };
  if (name === "run") return { kind: "run", verb: "Ran", detail };
  if (name === "set_command") return { kind: "run", verb: "Fixed command", detail };
  if (name === "get_log") return { kind: "run", verb: "Read log", detail };
  if (name === "git") return { kind: "git", verb: "Git", detail };
  if (name === "skill_get" || name === "skill_list")
    return { kind: "skill", verb: "Loaded skill", detail };
  if (name.startsWith("submit_"))
    return { kind: "submit", verb: `Submitted ${name.slice(7).replace("_", " ")}`, detail };
  return { kind: "other", verb: name, detail };
}

/** "Read 4 files · searched 2× · ran test" for a folded group of tool calls. */
export function summarizeTools(tools: readonly string[]): string {
  const counts = new Map<ToolKind, number>();
  const ran: string[] = [];
  for (const tool of tools) {
    const { kind, verb, detail } = describeTool(tool);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (verb === "Ran" && detail && !ran.includes(detail)) ran.push(detail);
  }
  const count = (kind: ToolKind) => counts.get(kind) ?? 0;
  const files = (n: number) => `${n} file${n > 1 ? "s" : ""}`;
  const parts: string[] = [];
  if (count("read")) parts.push(`read ${files(count("read"))}`);
  if (count("search")) parts.push(`searched ${count("search")}×`);
  if (count("edit")) parts.push(`edited ${files(count("edit"))}`);
  if (ran.length) parts.push(`ran ${ran.join(", ")}`);
  if (count("skill")) parts.push("loaded the harness skill");
  if (count("git")) parts.push("checked git");
  for (const tool of tools) {
    const { kind, verb } = describeTool(tool);
    if (kind === "submit" && !parts.includes(verb.toLowerCase())) parts.push(verb.toLowerCase());
  }
  const named = ["read", "search", "edit", "skill", "git", "submit"] as const;
  const other =
    tools.length -
    named.reduce((sum, kind) => sum + count(kind), 0) -
    tools.filter((tool) => describeTool(tool).verb === "Ran").length;
  if (other > 0) parts.push(`${other} other step${other > 1 ? "s" : ""}`);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A path shown relative to the worktree when it is inside it. */
export function shortPath(detail: string, worktree: string | null): string {
  if (!worktree) return detail;
  const norm = (value: string) => value.replace(/\\/g, "/");
  const root = norm(worktree).replace(/\/$/, "");
  const text = norm(detail);
  return text.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? text.slice(root.length + 1)
    : detail;
}

export type PhaseState = "done" | "active" | "waiting" | "failed" | "pending";

export const RUN_PHASES: readonly { id: string; label: string; statuses: RunStatus[] }[] = [
  { id: "worktree", label: "Worktree", statuses: ["preparing"] },
  { id: "install", label: "Install", statuses: ["installing"] },
  { id: "plan", label: "Plan", statuses: ["planning", "awaiting_plan"] },
  { id: "implement", label: "Implement", statuses: ["running"] },
  { id: "checks", label: "Checks", statuses: ["verifying"] },
  { id: "review", label: "Review", statuses: ["reviewing", "ready_for_review"] },
  { id: "publish", label: "Draft PR", statuses: ["publishing", "completed"] },
];

const phaseIndex = (status: RunStatus) =>
  RUN_PHASES.findIndex((phase) => phase.statuses.includes(status));

/** Where each pipeline phase stands; a failed or stopped run marks the phase it stopped in. */
export function runPhases(
  run: RunRecord,
  events: readonly RunEvent[],
): { id: string; label: string; state: PhaseState }[] {
  let current = phaseIndex(run.status);
  const stopped = current < 0;
  if (stopped) {
    for (const event of events)
      if (event.type === "status" && phaseIndex(event.status) >= 0)
        current = phaseIndex(event.status);
  }
  const phases = run.mode === "agent" ? RUN_PHASES : RUN_PHASES.slice(0, 2);
  return phases.map((phase, index) => {
    let state: PhaseState = "pending";
    if (run.status === "completed" || run.status === "prepared" || index < current) state = "done";
    else if (index === current)
      state = stopped
        ? run.status === "finished"
          ? "done"
          : "failed"
        : isRunBusy(run.status)
          ? "active"
          : "waiting";
    return { id: phase.id, label: phase.label, state };
  });
}

/** One line on what is happening now, while the run is busy; null when it waits or ended. */
export function currentActivity(run: RunRecord, events: readonly RunEvent[]): string | null {
  if (!isRunBusy(run.status)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "agent" && event.kind === "tool") return event.text;
    if (event.type === "agent" && event.kind === "text") return "Writing";
    if (event.type === "step_start") return `Running ${event.step}: ${event.command}`;
    if (event.type === "step_end") break;
    if (event.type === "status") break;
  }
  return ACTIVITY[run.status] ?? "Working";
}

const ACTIVITY: Partial<Record<RunStatus, string>> = {
  preparing: "Creating the worktree",
  installing: "Installing dependencies",
  planning: "Reading the code",
  running: "Working on the change",
  verifying: "Running the checks",
  reviewing: "Reviewing the change",
  publishing: "Opening the Draft PR",
};

/** True while the agent itself is thinking, so the chat shows a typing bubble. */
export function agentIsThinking(run: RunRecord, events: readonly RunEvent[]): boolean {
  if (!["planning", "running", "reviewing"].includes(run.status)) return false;
  const last = events[events.length - 1];
  return !(last?.type === "agent" && last.kind === "text");
}
