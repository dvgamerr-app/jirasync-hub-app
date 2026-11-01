import { useMemo, useState } from "react";
import type { Task } from "@/types/jira";
import { buildAiContext } from "@/lib/ai-context";
import { getAccountIdFromTask } from "@/lib/jira-ids";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export function CopyForAiDialog({
  task,
  tasks,
  onClose,
}: {
  task: Task;
  tasks: Task[];
  onClose: () => void;
}) {
  const [includeNote, setIncludeNote] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const context = useMemo(
    () =>
      buildAiContext(task, {
        parent: tasks.find(
          (candidate) =>
            candidate.jiraTaskId === task.parentKey &&
            getAccountIdFromTask(candidate) === getAccountIdFromTask(task),
        ),
        includeNote,
      }),
    [task, tasks, includeNote],
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogTitle>Copy for AI — {task.jiraTaskId}</DialogTitle>
        <DialogDescription>
          Preview the context before copying it to your AI tool.
        </DialogDescription>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeNote}
            onChange={(event) => {
              setIncludeNote(event.target.checked);
              setCopied(false);
            }}
          />{" "}
          Include local note
        </label>
        <Textarea
          aria-label="AI context preview"
          readOnly
          value={context}
          className="h-80 font-mono text-xs"
        />
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(context);
              setError("");
              setCopied(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {copied ? "Copied" : "Copy context"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
