import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowUpRight,
  Bot,
  Check,
  FolderOpen,
  Loader2,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { openExternal } from "@/lib/desktop";
import { useTaskStore } from "@/store/task-store";
import {
  isRunBusy,
  type RunDecision,
  type RunEvent,
  type RunRecord,
  type RunStatus,
  getPrChecks,
  type CiStatus,
} from "@/lib/harness";
import { cn, getErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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

/** Lines shown in the panel; the full log stays in the run journal on disk. */
const VISIBLE_LINES = 200;

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
      return `◆ ${event.text}`;
    case "permission":
      return event.decision === "deny" ? `⛔ denied ${event.tool}` : null;
    default:
      return null;
  }
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = run.prUrl ?? "";

  async function act(action: () => Promise<void>) {
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

  return (
    <div className="space-y-2" aria-label="Pull request">
      <button
        type="button"
        className="text-primary flex items-center gap-1 text-[12px] underline"
        onClick={() => void openExternal(url)}
      >
        {run.prReady ? "Pull request (ready for review)" : "Draft pull request"}
        <ArrowUpRight className="h-3 w-3" />
      </button>
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

export function TaskRunPanel({ task }: { task: Task }) {
  const { runs, runEvents, bindings, start, resume, stop, loadEvents, removeWorktree, openSetup } =
    useTaskStore(
      useShallow((state) => ({
        runs: state.runs,
        runEvents: state.runEvents,
        bindings: state.repoBindings,
        start: state.startTaskRun,
        resume: state.resumeTaskRun,
        stop: state.stopTaskRun,
        loadEvents: state.loadRunEvents,
        removeWorktree: state.removeTaskRunWorktree,
        openSetup: state.setHarnessSetupOpen,
      })),
    );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [includeNote, setIncludeNote] = useState(false);

  const binding = bindings.find((entry) => entry.projectId === task.projectId);
  const run = runs.find((candidate) => candidate.taskId === task.id);
  const activeElsewhere = runs.find(
    (candidate) => candidate.taskId !== task.id && isRunBusy(candidate.status),
  );
  const active = !!run && isRunBusy(run.status);
  const events = run ? runEvents[run.runId] : undefined;
  const lines = useMemo(
    () =>
      (events ?? [])
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

  const runId = run?.runId;
  useEffect(() => {
    if (runId && events === undefined) void loadEvents(runId).catch(() => {});
  }, [runId, events, loadEvents]);

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

  function decide(decision: RunDecision) {
    if (!run) return;
    void act(async () => {
      await resume(run.runId, decision, feedback);
      setFeedback("");
    });
  }

  if (!binding && !run) {
    return (
      <section className="board-detail-section" aria-label="Agent run">
        <h3>Agent run</h3>
        <p className="text-muted-foreground text-[12px]">
          This project has no repository yet. Bind one to prepare a workspace for its tasks.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[12px]"
          onClick={() => openSetup(true)}
        >
          Open Setup
        </Button>
      </section>
    );
  }

  const worktree = run?.worktree && !run.worktreeRemoved ? run.worktree : null;
  const waiting = run?.status === "awaiting_plan" || run?.status === "ready_for_review";
  const startBlocked = activeElsewhere
    ? `Another run (${activeElsewhere.issueKey}) is active. Stop it or wait for it to finish.`
    : !binding
      ? "This project has no repository anymore."
      : "";
  const feedbackBox = (placeholder: string) => (
    <textarea
      aria-label="Feedback for the agent"
      className="border-input bg-background w-full rounded-md border p-2 text-[12px]"
      rows={3}
      placeholder={placeholder}
      value={feedback}
      onChange={(event) => setFeedback(event.target.value)}
    />
  );

  return (
    <section className="board-detail-section" aria-label="Agent run">
      <h3>Agent run</h3>
      {run && (
        <p className="text-[12px]" role="status" aria-label="Run status">
          <span className={cn("font-medium", run.status === "failed" && "text-destructive")}>
            {STATUS_LABEL[run.status]}
          </span>
          {run.error && <span className="text-muted-foreground"> · {run.error}</span>}
        </p>
      )}
      {run?.mode === "agent" && (
        <p className="text-muted-foreground text-[11px]">
          Agent working time {Math.round(run.aiMs / 1000)}s
          {run.attempts > 0 && ` · ${run.attempts} repair round${run.attempts > 1 ? "s" : ""}`}
        </p>
      )}
      {worktree && (
        <p className="text-muted-foreground truncate font-mono text-[11px]" title={worktree.path}>
          {worktree.branch} · {worktree.path}
        </p>
      )}

      {run?.status === "awaiting_plan" && (
        <div className="space-y-2" aria-label="Plan review">
          <pre className="board-run-log" aria-label="Agent plan">
            {run.plan}
          </pre>
          {feedbackBox("Optional: what should change in the plan?")}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={busy || !!activeElsewhere}
              onClick={() => decide("approve_plan")}
            >
              <Check className="h-3 w-3" />
              Approve plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={busy || !feedback.trim() || !!activeElsewhere}
              onClick={() => decide("revise_plan")}
            >
              Revise plan
            </Button>
          </div>
        </div>
      )}

      {run?.status === "ready_for_review" && (
        <div className="space-y-2" aria-label="Change review">
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
            <pre className="board-run-log" aria-label="Agent progress">
              {run.progress}
            </pre>
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
                      setFeedback(
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
          {feedbackBox("What should the agent change?")}
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={busy}
              onClick={() => decide("accept")}
            >
              <Check className="h-3 w-3" />
              Accept &amp; open Draft PR
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              disabled={busy || !feedback.trim() || !!activeElsewhere}
              onClick={() => decide("request_changes")}
            >
              Request changes
            </Button>
          </div>
        </div>
      )}

      {run?.status === "completed" && run.prUrl && <PullRequestPanel run={run} />}

      {run && canContinue(run) && (
        <div className="space-y-2">
          {feedbackBox("Tell the agent how to continue")}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            disabled={busy || !feedback.trim() || !!activeElsewhere}
            onClick={() => decide("request_changes")}
          >
            Continue with instructions
          </Button>
        </div>
      )}

      {lines.length > 0 && (
        <pre className="board-run-log" aria-label="Run log">
          {lines.map((line) => (
            <div key={line.seq} className={cn(line.err && "text-amber-600 dark:text-amber-400")}>
              {line.text}
            </div>
          ))}
        </pre>
      )}
      {error && (
        <p className="text-destructive text-[12px]" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
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
        {!active && !waiting && (
          <>
            <Button
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={busy || !!startBlocked}
              title={
                startBlocked ||
                "Prepare the workspace, then Claude plans read-only and waits for your approval"
              }
              onClick={() => void act(() => start(task.id, { agent: true, includeNote }))}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
              Plan with Claude
            </Button>
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
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={includeNote}
                onChange={(event) => setIncludeNote(event.target.checked)}
              />
              Send my local note to the agent
            </label>
          </>
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
