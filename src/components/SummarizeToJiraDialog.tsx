import { useTaskStore, type SummaryOperation } from "@/store/task-store";
import { useShallow } from "zustand/react/shallow";
import { describeMinutes, parseTimeInput } from "@/lib/worklog-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export function SummarizeToJiraDialog() {
  const { taskId, drafts, close, update, submit, reset } = useTaskStore(
    useShallow((state) => ({
      taskId: state.summaryTaskId,
      drafts: state.summaryDrafts,
      close: state.closeSummary,
      update: state.updateSummaryDraft,
      submit: state.submitSummaryOperation,
      reset: state.resetSummaryOperation,
    })),
  );
  const draft = taskId ? drafts[taskId] : undefined;
  if (!draft) return null;
  const commentLocked = !["idle", "error"].includes(draft.commentStatus);
  const worklogLocked = !["idle", "error"].includes(draft.worklogStatus);
  const minutes = parseTimeInput(draft.timeInput);
  const operationControls = (operation: SummaryOperation) => {
    const status = draft[`${operation}Status`];
    const error = draft[`${operation}Error`];
    return (
      <>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {status === "done" && (
          <p role="status" className="text-sm">
            {operation === "comment" ? "Comment posted" : "Worklog saved locally — not pushed"}
          </p>
        )}
        {status === "done" || status === "unknown" ? (
          <Button variant="outline" onClick={() => reset(draft.taskId, operation)}>
            {status === "unknown"
              ? "I checked Jira — start a new comment"
              : `Start a new ${operation}`}
          </Button>
        ) : (
          <Button
            disabled={
              status === "pending" ||
              (operation === "comment"
                ? !draft.summary.trim()
                : !minutes || minutes <= 0 || !draft.logDate)
            }
            onClick={() => void submit(draft.taskId, operation)}
          >
            {status === "pending"
              ? "Saving…"
              : operation === "comment"
                ? "Post comment"
                : "Add worklog"}
          </Button>
        )}
      </>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>Summarize to Jira — {draft.jiraTaskId}</DialogTitle>
        <DialogDescription>
          Drafts stay on this ticket while the app is open. Post the comment and save time
          separately. Drafts clear on reload or restart.
        </DialogDescription>
        <section className="space-y-2">
          <label htmlFor="jira-summary" className="text-sm font-medium">
            Summary
          </label>
          <Textarea
            id="jira-summary"
            placeholder="Paste your AI summary…"
            value={draft.summary}
            disabled={commentLocked}
            onChange={(event) => update(draft.taskId, { summary: event.target.value })}
          />
          {operationControls("comment")}
        </section>
        <section className="border-border space-y-2 border-t pt-4">
          <label htmlFor="summary-date" className="text-sm">
            Work date
          </label>
          <Input
            id="summary-date"
            type="date"
            value={draft.logDate}
            disabled={worklogLocked}
            onChange={(event) => update(draft.taskId, { logDate: event.target.value })}
          />
          <label htmlFor="summary-time" className="text-sm">
            Time spent
          </label>
          <Input
            id="summary-time"
            placeholder="e.g. 30m or 2h"
            value={draft.timeInput}
            disabled={worklogLocked}
            onChange={(event) => update(draft.taskId, { timeInput: event.target.value })}
          />
          {draft.timeInput && (
            <p className="text-muted-foreground text-xs">
              {minutes ? `= ${describeMinutes(minutes)}` : "Not recognised — use 30m or 2h."}
              {minutes && minutes > 1440 ? " More than 24h; a plain number means hours." : ""}
            </p>
          )}
          <label htmlFor="summary-work-comment" className="text-sm">
            Worklog comment
          </label>
          <Textarea
            id="summary-work-comment"
            value={draft.worklogComment}
            disabled={worklogLocked}
            onChange={(event) => update(draft.taskId, { worklogComment: event.target.value })}
          />
          {operationControls("worklog")}
        </section>
      </DialogContent>
    </Dialog>
  );
}
