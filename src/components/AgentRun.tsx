// The AI Board's view of a task's agent run: the conversation (right panel), the raw worktree
// log, and the floating chat box the owner uses to start, steer and accept the run.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Circle,
  FileText,
  FolderOpen,
  GitBranch,
  Pencil,
  Search,
  Send,
  Sparkles,
  Terminal,
  Loader2,
  Pause,
  Play,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { openExternal } from "@/lib/desktop";
import { useTaskStore } from "@/store/task-store";
import {
  getPrChecks,
  isRunBusy,
  type AgentProvider,
  type CiStatus,
  type RunDecision,
  type RunEvent,
  type RunRecord,
  type RunStatus,
} from "@/lib/harness";
import {
  agentIsThinking,
  buildConversation,
  currentActivity,
  describeTool,
  runPhases,
  shortPath,
  summarizeTools,
  type CommandItem,
  type Entry,
  type ToolKind,
  type TurnItem,
  type ConversationItem,
  type PhaseState,
} from "@/lib/run-conversation";
import { cn, getErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Task } from "@/types/jira";

const STATUS_LABEL: Record<RunStatus, string> = {
  preparing: "Creating worktree",
  installing: "Installing dependencies",
  planning: "Agent planning",
  awaiting_plan: "Plan ready for your review",
  running: "Agent working",
  verifying: "App running checks",
  reviewing: "Reviewer agent checking the change",
  ready_for_review: "Ready for review",
  publishing: "Committing, pushing and opening the Draft PR",
  completed: "Accepted",
  prepared: "Workspace ready",
  finished: "Agent finished",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

/** Lines shown in the worktree log; the full log stays in the run journal on disk. */
const VISIBLE_LINES = 200;
const NO_EVENTS: RunEvent[] = [];

function logLine(event: RunEvent): string | null {
  switch (event.type) {
    case "step_start":
      return `▶ ${event.step}: ${event.command}`;
    case "output":
      return event.text;
    case "step_end":
      return `■ ${event.step} ${event.exitCode === null ? "stopped" : `exit ${event.exitCode}`} · ${(event.durationMs / 1000).toFixed(1)}s`;
    case "agent":
      if (event.kind === "tool") return `→ ${event.text}`;
      if (event.kind === "plan") return "▣ plan submitted";
      if (event.kind === "result") return `✓ agent ${event.text}`;
      if (event.kind === "init") return `◆ agent started · ${event.text}`;
      if (event.kind === "owner") return `» you: ${event.text}`;
      return `◆ ${event.text}`;
    case "permission":
      return event.decision === "deny" ? `⛔ denied ${event.tool}` : null;
    default:
      return null;
  }
}

/** The agent can continue in the same session after a failure, a stop or an app restart. */
function canContinue(run: RunRecord): boolean {
  return (
    run.mode === "agent" &&
    !!run.sessionId &&
    !!run.worktree &&
    !run.worktreeRemoved &&
    ["failed", "cancelled", "interrupted"].includes(run.status)
  );
}

/** Everything the three views need about the task's latest run. */
function useTaskRun(task: Task) {
  const state = useTaskStore(
    useShallow((store) => ({
      runs: store.runs,
      runEvents: store.runEvents,
      bindings: store.repoBindings,
      doctor: store.harnessDoctor,
      boardRequests: store.boardRequests,
      loadEvents: store.loadRunEvents,
    })),
  );
  const run = state.runs.find((candidate) => candidate.taskId === task.id);
  const events = run ? state.runEvents[run.runId] : undefined;
  const runId = run?.runId;
  const { loadEvents } = state;
  useEffect(() => {
    if (runId && events === undefined) void loadEvents(runId).catch(() => {});
  }, [runId, events, loadEvents]);
  const activeElsewhere = state.runs.find(
    (candidate) => candidate.taskId !== task.id && isRunBusy(candidate.status),
  );
  const binding = state.bindings.find((entry) => entry.projectId === task.projectId);
  return {
    run,
    events: events ?? NO_EVENTS,
    binding,
    activeElsewhere,
    active: !!run && isRunBusy(run.status),
    // Codex is optional: offer it only when Doctor saw it start on this machine.
    codexReady: !!state.doctor?.tools.some((tool) => tool.name === "codex" && tool.ok),
    request: state.boardRequests.find(
      (candidate) => candidate.taskId === task.id && candidate.status === "pending",
    ),
    startBlocked: activeElsewhere
      ? `Another run (${activeElsewhere.issueKey}) is active. Stop it or wait for it to finish.`
      : !binding
        ? "This project has no repository yet. Bind one in Setup."
        : "",
  };
}

/** Runs an async action with busy and error state for one view. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, act };
}

const CI_LABEL: Record<CiStatus["checks"][number]["bucket"], string> = {
  pass: "passed",
  fail: "failed",
  pending: "running",
  skipping: "skipped",
  cancel: "cancelled",
};

/** The Draft PR of an accepted run: it becomes ready for review only after CI passes. */
function PullRequestPanel({ run }: { run: RunRecord }) {
  const markReady = useTaskStore((state) => state.markTaskPrReady);
  const [ci, setCi] = useState<CiStatus | null>(null);
  const { busy, error, act } = useAction();
  // One PR per repo the run changed (a submodule has its own); older runs list only prUrl.
  const urls = run.prUrls?.length ? run.prUrls : run.prUrl ? [run.prUrl] : [];
  const label = run.prReady ? "Pull request (ready for review)" : "Draft pull request";

  return (
    <div className="agent-card space-y-2" aria-label="Pull request">
      {urls.map((url) => (
        <button
          key={url}
          type="button"
          className="text-primary flex items-center gap-1 text-[12px] underline"
          onClick={() => void openExternal(url)}
        >
          {urls.length > 1 ? `${label} · ${url.split("/pull/")[0].split("/").pop()}` : label}
          <ArrowUpRight className="h-3 w-3" />
        </button>
      ))}
      {!run.prReady && (
        <>
          {ci && (
            <ul className="text-[12px]" aria-label="CI checks">
              {ci.checks.length === 0 && <li>CI has not reported any checks yet.</li>}
              {ci.checks.map((check) => (
                <li key={check.name}>
                  {check.name} {CI_LABEL[check.bucket] ?? check.bucket}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={busy}
              onClick={() => void act(async () => setCi(await getPrChecks(run.runId)))}
            >
              Check CI
            </Button>
            <Button
              size="sm"
              className="h-7 text-[12px]"
              disabled={busy || !ci?.allPassed}
              title={
                ci?.allPassed
                  ? "Mark the pull request ready for review"
                  : "Enabled when every CI check passed"
              }
              onClick={() => void act(() => markReady(run.runId))}
            >
              Ready for review
            </Button>
          </div>
        </>
      )}
      {error && (
        <p className="text-destructive text-[12px]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const PHASE_ICON: Record<PhaseState, ReactNode> = {
  done: <Check className="h-3 w-3 text-emerald-500" />,
  active: <Loader2 className="text-primary h-3 w-3 animate-spin" />,
  waiting: <Pause className="h-3 w-3 text-amber-500" />,
  failed: <X className="text-destructive h-3 w-3" />,
  pending: <Circle className="text-muted-foreground/50 h-3 w-3" />,
};

/** The pipeline as a collapsible list of steps; the header is the run status. */
function RunSteps({ run, events }: { run: RunRecord; events: readonly RunEvent[] }) {
  const phases = runPhases(run, events);
  return (
    <details className="agent-steps" open={isRunBusy(run.status)}>
      <summary>
        <ChevronRight className="agent-chevron h-3 w-3" />
        <span role="status" aria-label="Run status">
          <span className={cn("font-medium", run.status === "failed" && "text-destructive")}>
            {STATUS_LABEL[run.status]}
          </span>
          {run.error && <span className="text-muted-foreground"> · {run.error}</span>}
        </span>
      </summary>
      <ol aria-label="Run steps">
        {phases.map((phase) => (
          <li key={phase.id} data-state={phase.state}>
            {PHASE_ICON[phase.state]}
            {phase.label}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Older long messages fold to a few lines; the newest one always shows in full. */
function ClampedText({ text, clamp }: { text: string; clamp: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [text, clamp]);
  const folded = clamp && !open;
  return (
    <>
      <div ref={ref} className={cn(folded && "agent-clamp")}>
        {text}
      </div>
      {clamp && (overflows || open) && (
        <button type="button" className="agent-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

const TOOL_ICON: Record<ToolKind, typeof FileText> = {
  read: FileText,
  search: Search,
  edit: Pencil,
  run: Terminal,
  git: GitBranch,
  skill: BookOpen,
  submit: Send,
  other: Wrench,
};

/** Consecutive tool calls: one summary line, the calls as a feed under it. While the agent
 * works, the feed stays open on the latest calls so the owner can watch them land. */
function ToolGroup({
  tools,
  live,
  worktree,
}: {
  tools: string[];
  live: boolean;
  worktree: string | null;
}) {
  const shown = live ? tools.slice(-4) : tools;
  return (
    <details className="agent-tools" open={live || undefined}>
      <summary>
        <ChevronRight className="agent-chevron h-3 w-3" />
        <span>{summarizeTools(tools)}</span>
      </summary>
      <ul>
        {shown.map((tool, index) => {
          const { kind, verb, detail } = describeTool(tool);
          const Icon = TOOL_ICON[kind];
          const latest = live && index === shown.length - 1;
          return (
            <li key={`${tools.length - shown.length + index}`} data-latest={latest || undefined}>
              <Icon className="h-3 w-3 shrink-0" />
              <span className="agent-tool-verb">{verb}</span>
              <span className="agent-tool-detail" title={detail}>
                {shortPath(detail, worktree)}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function CommandCard({ item }: { item: CommandItem }) {
  return (
    <details className="agent-fold" aria-label={`Command ${item.step}`}>
      <summary>
        {item.done ? (
          item.exitCode === 0 ? (
            <Check className="h-3 w-3 shrink-0 text-emerald-500" />
          ) : (
            <X className="text-destructive h-3 w-3 shrink-0" />
          )
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        )}
        <span className="font-mono">{item.command}</span>
        {item.done && (
          <span className="text-muted-foreground ml-auto shrink-0">
            {item.exitCode === null ? "stopped" : `exit ${item.exitCode}`} ·{" "}
            {((item.durationMs ?? 0) / 1000).toFixed(1)}s
          </span>
        )}
      </summary>
      {item.lines.length > 0 && (
        <pre className="board-run-log">
          {item.lines.map((line, index) => (
            <div key={index} className={cn(line.err && "text-amber-600 dark:text-amber-400")}>
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </details>
  );
}

type RowContext = { latestMessage: number; worktree: string | null; liveTools: number };

function EntryRow({ entry, context }: { entry: Entry; context: RowContext }) {
  switch (entry.kind) {
    case "agent":
      return (
        <div className="agent-bubble" aria-label="Agent message">
          <ClampedText text={entry.text} clamp={entry.seq !== context.latestMessage} />
        </div>
      );
    case "tools":
      return (
        <ToolGroup
          tools={entry.tools}
          live={entry.seq === context.liveTools}
          worktree={context.worktree}
        />
      );
    case "command":
      return <CommandCard item={entry} />;
    case "notice":
      return (
        <p className={cn("agent-notice", entry.error && "is-error")} role="note">
          {entry.text}
        </p>
      );
  }
}

const formatSeconds = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    : `${Math.round(ms / 1000)}s`;

/** One agent session: an orb that breathes while it works, its phase, and what it did. */
function AgentTurn({
  item,
  agent,
  active,
  live,
  context,
}: {
  item: TurnItem;
  agent: string;
  active: boolean;
  live: ReactNode;
  context: RowContext;
}) {
  return (
    <section
      className="agent-turn"
      data-active={active || undefined}
      data-failed={item.failed || undefined}
      aria-label={`${agent}: ${item.label}`}
    >
      <header>
        <span className="agent-orb" aria-hidden>
          <Sparkles className="h-3 w-3" />
        </span>
        <span className={cn("agent-turn-title", active && "agent-shimmer")}>
          {agent} · {item.label}
        </span>
        {item.done && item.durationMs !== null && (
          <span className="agent-turn-time">{formatSeconds(item.durationMs)}</span>
        )}
      </header>
      <div className="agent-turn-body">
        {item.entries.map((entry) => (
          <EntryRow key={`${entry.kind}-${entry.seq}`} entry={entry} context={context} />
        ))}
        {active && live}
      </div>
    </section>
  );
}

function ConversationRow({
  item,
  agent,
  activeTurn,
  live,
  context,
}: {
  item: ConversationItem;
  agent: string;
  activeTurn: number;
  live: ReactNode;
  context: RowContext;
}) {
  if (item.kind === "owner")
    return (
      <div className="agent-bubble is-owner" aria-label="Your message">
        <ClampedText text={item.text} clamp={item.seq !== context.latestMessage} />
      </div>
    );
  if (item.kind === "turn")
    return (
      <AgentTurn
        item={item}
        agent={agent}
        active={item.seq === activeTurn}
        live={live}
        context={context}
      />
    );
  return <EntryRow entry={item} context={context} />;
}

/** "Read src/a.ts" rather than "Read C:\…\worktrees\abc\src\a.ts" for the live line. */
function readableActivity(activity: string, worktree: string | null): string {
  const { kind, verb, detail } = describeTool(activity);
  return kind === "other" ? activity : `${verb} ${shortPath(detail, worktree)}`.trim();
}

/** The newest message, the open agent session and its newest tool group, by seq. */
function conversationFocus(items: ConversationItem[], busy: boolean) {
  let latestMessage = -1;
  let activeTurn = -1;
  let liveTools = -1;
  for (const item of items) {
    if (item.kind === "owner" || item.kind === "agent") latestMessage = item.seq;
    if (item.kind === "turn") {
      for (const entry of item.entries) if (entry.kind === "agent") latestMessage = entry.seq;
      if (busy && !item.done) {
        activeTurn = item.seq;
        const last = item.entries.at(-1);
        liveTools = last?.kind === "tools" ? last.seq : -1;
      }
    }
  }
  return { latestMessage, activeTurn, liveTools };
}

/** Right panel, Conversation tab: what the owner and the agent said, and the run's gates. */
export function AgentConversation({ task }: { task: Task }) {
  const { run, events, binding, request, startBlocked } = useTaskRun(task);
  const { resolveRequest, openSetup, setDraft } = useTaskStore(
    useShallow((state) => ({
      resolveRequest: state.resolveBoardRequest,
      openSetup: state.setHarnessSetupOpen,
      setDraft: state.setBoardAgentDraft,
    })),
  );
  const { busy, error, act } = useAction();
  const items = useMemo(() => buildConversation(events), [events]);
  const activity = run ? currentActivity(run, events) : null;
  const thinking = run ? agentIsThinking(run, events) : false;
  const focus = conversationFocus(items, !!run && isRunBusy(run.status));
  const context: RowContext = {
    latestMessage: focus.latestMessage,
    worktree: run?.worktree?.path ?? null,
    liveTools: focus.liveTools,
  };
  const agentName = run?.provider === "codex" ? "Codex" : "Claude";
  // What the agent is doing now: inside its open session, or at the end while the app works.
  const live = (thinking || activity) && (
    <div className="agent-live">
      {thinking && (
        <span className="agent-typing" aria-label="Agent is thinking">
          <span />
          <span />
          <span />
        </span>
      )}
      {activity && (
        <p className="agent-activity" aria-live="polite" aria-label="Agent activity">
          <span className="agent-shimmer">{readableActivity(activity, context.worktree)}</span>
        </p>
      )}
    </div>
  );
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [items.length, activity, run?.status]);

  return (
    <section className="agent-conversation" aria-label="Agent run">
      {request && (
        <div className="agent-card space-y-1 text-[12px]" aria-label="Agent request">
          <p>
            An external agent asked to run this task with{" "}
            {request.provider === "codex" ? "Codex" : "Claude"}
            {request.note ? `: ${request.note}` : "."}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-[12px]"
              disabled={busy || !!startBlocked}
              title={
                startBlocked || "Starts the run; the agent still plans first and waits for you"
              }
              onClick={() => void act(() => resolveRequest(request.requestId, true))}
            >
              Approve &amp; plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={busy}
              onClick={() => void act(() => resolveRequest(request.requestId, false))}
            >
              Decline
            </Button>
          </div>
        </div>
      )}

      {!run && !binding && (
        <div className="agent-empty">
          <Bot className="h-5 w-5" />
          <p>This project has no repository yet. Bind one to let an agent work on its tasks.</p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => openSetup(true)}
          >
            Open Setup
          </Button>
        </div>
      )}
      {!run && binding && (
        <div className="agent-empty">
          <Bot className="h-5 w-5" />
          <p>
            Ask the agent below. It reads the ticket, plans read-only, and waits for you to approve
            before it changes anything.
          </p>
        </div>
      )}

      {run && <RunSteps run={run} events={events} />}
      {items.map((item) => (
        <ConversationRow
          key={`${item.kind}-${item.seq}`}
          item={item}
          agent={agentName}
          activeTurn={focus.activeTurn}
          live={live}
          context={context}
        />
      ))}

      {run?.status === "awaiting_plan" && run.plan && (
        <div className="agent-card" aria-label="Plan review">
          <h4>Plan</h4>
          <div className="agent-plan" aria-label="Agent plan">
            {run.plan}
          </div>
          <p className="text-muted-foreground text-[11px]">
            Approve it in the chat box, or write what should change.
          </p>
        </div>
      )}

      {run?.status === "ready_for_review" && (
        <div className="agent-card space-y-2" aria-label="Change review">
          <ul className="text-[12px]" aria-label="Checks">
            {run.checks.length === 0 && (
              <li className="text-amber-600 dark:text-amber-400">
                No build, lint or test command is set; nothing was checked.
              </li>
            )}
            {run.checks.map((check) => (
              <li key={check.name} className="flex items-center gap-1.5">
                {check.status === "passed" ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <X className="text-destructive h-3 w-3" />
                )}
                {check.name} {check.status}
              </li>
            ))}
          </ul>
          <p className="text-[12px]" aria-label="Changed files">
            {run.changedFiles.length === 0
              ? "No files changed."
              : `Changed: ${run.changedFiles.join(", ")}`}
          </p>
          {run.progress && (
            <div className="agent-plan" aria-label="Agent progress">
              {run.progress}
            </div>
          )}
          {run.review && (
            <div className="space-y-1 text-[12px]" aria-label="Independent review">
              <p>
                <span
                  className={cn(
                    "font-medium",
                    run.review.verdict === "concerns" && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {run.review.verdict === "approve"
                    ? "Reviewer agent: no concerns"
                    : run.review.verdict === "concerns"
                      ? "Reviewer agent: concerns"
                      : "Not reviewed"}
                </span>{" "}
                · {run.review.summary}
              </p>
              {run.review.findings.length > 0 && (
                <>
                  <ul className="list-disc pl-4">
                    {run.review.findings.map((finding, index) => (
                      <li key={index}>
                        {finding.file && <span className="font-mono">{finding.file}: </span>}
                        {finding.issue}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() =>
                      setDraft(
                        run
                          .review!.findings.map(
                            (finding) =>
                              `- ${finding.file ? `${finding.file}: ` : ""}${finding.issue}`,
                          )
                          .join("\n"),
                      )
                    }
                  >
                    Use findings as feedback
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {run?.status === "completed" && run.prUrl && <PullRequestPanel run={run} />}

      {focus.activeTurn < 0 && live}
      {error && (
        <p className="text-destructive text-[12px]" role="alert">
          {error}
        </p>
      )}
      <div ref={end} />
    </section>
  );
}

/** Right panel, Worktree log tab: the raw run log and the workspace itself. */
export function AgentWorkspace({ task }: { task: Task }) {
  const { run, events, active, startBlocked } = useTaskRun(task);
  const { start, removeWorktree } = useTaskStore(
    useShallow((state) => ({
      start: state.startTaskRun,
      removeWorktree: state.removeTaskRunWorktree,
    })),
  );
  const { busy, error, act } = useAction();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const lines = useMemo(
    () =>
      events
        .map((event) => ({
          seq: event.seq,
          text: logLine(event),
          err:
            (event.type === "output" && event.stream === "stderr") || event.type === "permission",
        }))
        .filter((line) => line.text !== null)
        .slice(-VISIBLE_LINES),
    [events],
  );
  const worktree = run?.worktree && !run.worktreeRemoved ? run.worktree : null;
  const waiting = run?.status === "awaiting_plan" || run?.status === "ready_for_review";

  return (
    <section className="space-y-3 text-[12px]" aria-label="Worktree log">
      {run && <RunSteps run={run} events={events} />}
      {run?.mode === "agent" && (
        <p className="text-muted-foreground text-[11px]">
          <span aria-label="Coding agent">{run.provider === "codex" ? "Codex" : "Claude"}</span>
          {" · "}Agent working time {Math.round(run.aiMs / 1000)}s
          {run.attempts > 0 && ` · ${run.attempts} repair round${run.attempts > 1 ? "s" : ""}`}
        </p>
      )}
      {worktree ? (
        <p className="text-muted-foreground truncate font-mono text-[11px]" title={worktree.path}>
          {worktree.branch} · {worktree.path}
        </p>
      ) : (
        <p className="text-muted-foreground">No worktree for this task.</p>
      )}
      {lines.length > 0 && (
        <pre className="board-run-log agent-log" aria-label="Run log">
          {lines.map((line) => (
            <div key={line.seq} className={cn(line.err && "text-amber-600 dark:text-amber-400")}>
              {line.text}
            </div>
          ))}
        </pre>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!active && !waiting && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            disabled={busy || !!startBlocked}
            title={
              startBlocked || "Create a worktree from the latest base, copy env files and install"
            }
            onClick={() => void act(() => start(task.id))}
          >
            <Play className="h-3 w-3" />
            {run ? "Prepare again" : "Prepare workspace"}
          </Button>
        )}
        {worktree && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => void act(() => openPath(worktree.path))}
          >
            <FolderOpen className="h-3 w-3" />
            Open folder
          </Button>
        )}
        {run && worktree && !active && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                try {
                  await removeWorktree(run.runId, false);
                } catch (removeError) {
                  if (getErrorMessage(removeError).includes("uncommitted")) setConfirmDiscard(true);
                  throw removeError;
                }
              })
            }
          >
            <Trash2 className="h-3 w-3" />
            Remove worktree
          </Button>
        )}
        {run && confirmDiscard && worktree && !active && (
          <Button
            variant="destructive"
            size="sm"
            className="h-7 text-[12px]"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await removeWorktree(run.runId, true);
                setConfirmDiscard(false);
              })
            }
          >
            Discard changes and remove
          </Button>
        )}
      </div>
      {startBlocked && !active && !waiting && (
        <p className="text-muted-foreground text-[11px]">{startBlocked}</p>
      )}
    </section>
  );
}

const PROVIDER_LABEL: Record<AgentProvider, string> = { claude: "Claude", codex: "Codex" };

/** The floating chat box: one place to start, steer, approve and accept the selected run. */
export function AgentComposer({ task }: { task: Task }) {
  const { run, binding, active, activeElsewhere, codexReady, startBlocked } = useTaskRun(task);
  const { draft, setDraft, start, resume, stop } = useTaskStore(
    useShallow((state) => ({
      draft: state.boardAgentDraft,
      setDraft: state.setBoardAgentDraft,
      start: state.startTaskRun,
      resume: state.resumeTaskRun,
      stop: state.stopTaskRun,
    })),
  );
  const { busy, error, act } = useAction();
  // A run being continued keeps its coding agent unless the owner picks another.
  const [provider, setProvider] = useState<AgentProvider>(
    run?.provider === "codex" ? "codex" : "claude",
  );
  const [includeNote, setIncludeNote] = useState(false);
  const text = draft.trim();

  if (!run && !binding) return null;
  const status = run?.status;
  const idle = !active && status !== "awaiting_plan" && status !== "ready_for_review";
  const blocked = busy || !!activeElsewhere;
  // Planning again carries on in the task's existing worktree (store: startTaskRun).
  const reuse = idle && run?.worktree && !run.worktreeRemoved ? run.worktree : null;

  function decide(decision: RunDecision) {
    if (!run) return;
    void act(async () => {
      await resume(run.runId, decision, draft);
      setDraft("");
    });
  }
  function plan() {
    void act(async () => {
      await start(task.id, { agent: true, includeNote, provider, message: draft });
      setDraft("");
    });
  }
  // Enter sends the safe default for the current gate; Accept always needs a click.
  function send() {
    if (status === "awaiting_plan") decide(text ? "revise_plan" : "approve_plan");
    else if (status === "ready_for_review" || (run && canContinue(run))) {
      if (text) decide("request_changes");
    } else if (idle && !startBlocked) plan();
  }

  const placeholder = active
    ? "The agent is working. Stop it to change course."
    : status === "awaiting_plan"
      ? "Approve with Enter, or write what should change in the plan"
      : status === "ready_for_review"
        ? "What should the agent change?"
        : run && canContinue(run)
          ? "Tell the agent how to continue"
          : reuse
            ? `Ask ${PROVIDER_LABEL[provider]} for more work on ${task.jiraTaskId} in its worktree`
            : `Ask ${PROVIDER_LABEL[provider]} to work on ${task.jiraTaskId} (optional instructions)`;

  return (
    <section className="agent-composer" aria-label="Agent chat">
      {error && (
        <p className="text-destructive px-1 text-[12px]" role="alert">
          {error}
        </p>
      )}
      <textarea
        aria-label="Feedback for the agent"
        rows={2}
        value={draft}
        disabled={active}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!blocked) send();
          }
        }}
      />
      <div className="agent-composer-bar">
        <span className="agent-composer-key">{task.jiraTaskId}</span>
        {reuse && (
          <span
            className="text-muted-foreground truncate font-mono text-[11px]"
            title={reuse.path}
            aria-label="Continues in worktree"
          >
            ↳ {reuse.branch}
          </span>
        )}
        {idle && (
          <>
            {codexReady && (
              <Select
                value={provider}
                onValueChange={(value) => setProvider(value as AgentProvider)}
              >
                <SelectTrigger aria-label="Coding agent provider" className="h-7 w-24 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            )}
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={includeNote}
                onChange={(event) => setIncludeNote(event.target.checked)}
              />
              Send my local note
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {active && run && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={busy}
              onClick={() => void act(() => stop(run.runId))}
            >
              <Square className="h-3 w-3" />
              Stop
            </Button>
          )}
          {status === "awaiting_plan" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                disabled={blocked || !text}
                onClick={() => decide("revise_plan")}
              >
                Revise plan
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                disabled={blocked}
                onClick={() => decide("approve_plan")}
              >
                <Check className="h-3 w-3" />
                Approve plan
              </Button>
            </>
          )}
          {status === "ready_for_review" && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[12px]"
                disabled={blocked || !text}
                onClick={() => decide("request_changes")}
              >
                Request changes
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                disabled={busy}
                onClick={() => decide("accept")}
              >
                <Check className="h-3 w-3" />
                Accept &amp; open Draft PR
              </Button>
            </>
          )}
          {run && canContinue(run) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={blocked || !text}
              onClick={() => decide("request_changes")}
            >
              Continue with instructions
            </Button>
          )}
          {idle && (
            <Button
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={busy || !!startBlocked}
              title={
                startBlocked ||
                `Prepare the workspace, then ${PROVIDER_LABEL[provider]} plans read-only and waits for your approval`
              }
              onClick={plan}
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ArrowUp className="h-3 w-3" />
              )}
              Plan with {PROVIDER_LABEL[provider]}
            </Button>
          )}
        </div>
      </div>
      {startBlocked && idle && (
        <p className="text-muted-foreground px-1 text-[11px]">{startBlocked}</p>
      )}
    </section>
  );
}
