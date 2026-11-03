import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openPath } from "@tauri-apps/plugin-opener";
import { FolderOpen, Loader2, Play, Square, Trash2 } from "lucide-react";
import { useTaskStore } from "@/store/task-store";
import { TERMINAL_RUN_STATUSES, type RunEvent, type RunStatus } from "@/lib/harness";
import { cn, getErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Task } from "@/types/jira";

const STATUS_LABEL: Record<RunStatus, string> = {
  preparing: "Creating worktree",
  installing: "Installing dependencies",
  running: "Agent working",
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
    default:
      return null;
  }
}

export function TaskRunPanel({ task }: { task: Task }) {
  const { runs, runEvents, bindings, start, stop, loadEvents, removeWorktree, openSetup } =
    useTaskStore(
      useShallow((state) => ({
        runs: state.runs,
        runEvents: state.runEvents,
        bindings: state.repoBindings,
        start: state.startTaskRun,
        stop: state.stopTaskRun,
        loadEvents: state.loadRunEvents,
        removeWorktree: state.removeTaskRunWorktree,
        openSetup: state.setHarnessSetupOpen,
      })),
    );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const binding = bindings.find((entry) => entry.projectId === task.projectId);
  const run = runs.find((candidate) => candidate.taskId === task.id);
  const activeElsewhere = runs.find(
    (candidate) => candidate.taskId !== task.id && !TERMINAL_RUN_STATUSES.has(candidate.status),
  );
  const active = !!run && !TERMINAL_RUN_STATUSES.has(run.status);
  const events = run ? runEvents[run.runId] : undefined;
  const lines = useMemo(
    () =>
      (events ?? [])
        .map((event) => ({
          seq: event.seq,
          text: logLine(event),
          err: event.type === "output" && event.stream === "stderr",
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
  const startBlocked = activeElsewhere
    ? `Another run (${activeElsewhere.issueKey}) is active. Stop it or wait for it to finish.`
    : !binding
      ? "This project has no repository anymore."
      : "";

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
      {worktree && (
        <p className="text-muted-foreground truncate font-mono text-[11px]" title={worktree.path}>
          {worktree.branch} · {worktree.path}
        </p>
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
        {active ? (
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
        ) : (
          <Button
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            disabled={busy || !!startBlocked}
            title={
              startBlocked || "Create a worktree from the latest base, copy env files and install"
            }
            onClick={() => void act(() => start(task.id))}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
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
      {startBlocked && !active && (
        <p className="text-muted-foreground text-[11px]">{startBlocked}</p>
      )}
    </section>
  );
}
