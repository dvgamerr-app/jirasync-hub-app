import { useState } from "react";
import { useTaskStore } from "@/store/task-store";
import { StatusBadge } from "@/components/StatusBadge";
import { StoryLevel, TaskType, Severity } from "@/types/jira";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Clock, CloudOff, Cloud, CloudUpload, ExternalLink, Bug, BookOpen, ClipboardList, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "@/hooks/use-toast";
import { openExternal } from "@/lib/window-rpc";
import { LogWorkModal, formatMinutes } from "@/components/LogWorkModal";

const TASK_TYPES: TaskType[] = ["Story", "Bug", "Task"];
const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "NA"];

export function TaskDetailPanel() {
  const {
    selectedTaskId,
    setSelectedTask,
    getTaskById,
    getProjectById,
    getStatusesForProject,
    getWorkLogsForTask,
    updateTaskStatus,
    updateTaskStoryLevel,
    updateTaskMandays,
    updateTaskType,
    updateTaskSeverity,
    updateTaskRefUrl,
    updateTaskNote,
    addWorkLog,
    removeWorkLog,
    syncTaskToJira,
  } = useTaskStore();

  if (!selectedTaskId) return null;

  const task = getTaskById(selectedTaskId);
  if (!task) return null;

  const project = getProjectById(task.projectId);
  const statuses = getStatusesForProject(task.projectId);
  const workLogs = getWorkLogsForTask(task.id);

  return (
    <div className="flex h-full w-full md:w-[45vw] md:min-w-[360px] md:max-w-[600px] flex-col border-l border-border bg-card animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {task.jiraTaskId}
          </span>
          {task.isSynced ? (
            <Cloud className="h-3.5 w-3.5 text-success" />
          ) : (
            <CloudOff className="h-3.5 w-3.5 text-warning" />
          )}
          {task.isDirty && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 text-[11px] px-2"
              onClick={async () => {
                try {
                  await syncTaskToJira(task.id);
                  toast({ title: "Synced to Jira", description: `${task.jiraTaskId} synced` });
                } catch {
                  toast({ title: "Sync failed", description: `Could not sync ${task.jiraTaskId}`, variant: "destructive" });
                }
              }}
            >
              <CloudUpload className="h-3 w-3" />
              Sync
            </Button>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedTask(null)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <h2 className="text-base font-semibold leading-snug">{task.title}</h2>

        {task.description && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">{task.description}</p>
        )}

        {/* Fields Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Type */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Type</label>
            <Select value={task.type ?? ""} onValueChange={(v) => updateTaskType(task.id, v as TaskType)}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue placeholder="—">
                  <div className="flex items-center gap-1.5">
                    {task.type === "Bug" && <Bug className="h-3.5 w-3.5 text-destructive" />}
                    {task.type === "Story" && <BookOpen className="h-3.5 w-3.5 text-primary" />}
                    {task.type === "Task" && <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />}
                    {task.type}
                  </div>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TASK_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="text-[13px]">{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Severity */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Severity</label>
            <Select value={task.severity ?? ""} onValueChange={(v) => updateTaskSeverity(task.id, v as Severity)}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s} className="text-[13px]">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Status */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</label>
            <Select value={task.status ?? ""} onValueChange={(v) => updateTaskStatus(task.id, v)}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue>
                  <StatusBadge status={task.status} />
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s} value={s} className="text-[13px]">
                    <StatusBadge status={s} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Story Level */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Story Level</label>
            <Select
              value={task.storyLevel?.toString() ?? ""}
              onValueChange={(v) => updateTaskStoryLevel(task.id, (v ? Number(v) : null) as StoryLevel | null)}
            >
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 5].map((l) => (
                  <SelectItem key={l} value={l.toString()} className="text-[13px]">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Mandays */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Mandays</label>
            <Input
              type="number"
              min={0}
              step={0.5}
              className="h-8 text-[13px]"
              value={task.mandays ?? ""}
              onChange={(e) => updateTaskMandays(task.id, e.target.value ? Number(e.target.value) : null)}
            />
          </div>

          {/* Assignee */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Assignee</label>
            <div className="flex h-8 items-center rounded-md border border-input bg-background px-3 text-[13px] text-muted-foreground">
              {task.assignee ?? "—"}
            </div>
          </div>
        </div>

        {/* Ref URL */}
        <EditableField
          label="Ref URL"
          value={task.refUrl}
          onSave={(v) => updateTaskRefUrl(task.id, v)}
          placeholder="https://..."
          isLink
        />

        {/* Note */}
        <EditableField
          label="Note"
          value={task.note}
          onSave={(v) => updateTaskNote(task.id, v)}
          placeholder="Add a note..."
        />

        {/* Project Info */}
        {project && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
            {project.name} · {project.jiraProjectKey}
          </div>
        )}

        {/* Timestamps */}
        <div className="flex gap-4 text-[11px] text-muted-foreground">
          <span>Created {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}</span>
          <span>Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}</span>
        </div>

        {/* Time Tracking */}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Time Tracking
            </h3>
            <LogWorkModal taskId={task.id} onLog={addWorkLog} variant="button" />
          </div>

          {workLogs.length > 0 && (
            <div className="text-[12px] text-muted-foreground">
              Total: {formatMinutes(workLogs.reduce((sum, wl) => sum + wl.timeSpentMinutes, 0))}
            </div>
          )}

          <div className="space-y-2">
            {workLogs.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No work logged yet</p>
            ) : (
              workLogs.map((wl) => (
                <div key={wl.id} className="rounded-md border border-border bg-muted/20 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium tabular-nums">{formatMinutes(wl.timeSpentMinutes)}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">{wl.logDate}</span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => removeWorkLog(wl.id)}
                        title="Delete work log"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  {wl.comment && (
                    <p className="mt-1 text-[12px] text-muted-foreground">{wl.comment}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditableField({
  label,
  value,
  onSave,
  placeholder,
  isLink,
}: {
  label: string;
  value: string | null;
  onSave: (value: string | null) => void;
  placeholder?: string;
  isLink?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(value ?? "");

  const commit = () => {
    onSave(inputValue.trim() || null);
    setEditing(false);
  };

  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      {editing ? (
        <Input
          autoFocus
          className="h-8 text-[13px]"
          value={inputValue}
          placeholder={placeholder}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <div
          className="flex h-8 items-center rounded-md border border-input bg-background px-3 text-[13px] cursor-text hover:bg-accent/50 transition-colors"
          onClick={() => { setInputValue(value ?? ""); setEditing(true); }}
        >
          {value ? (
            isLink ? (
              <button
                type="button"
                className="flex items-center gap-1 text-primary hover:underline truncate"
                onClick={(e) => { e.stopPropagation(); openExternal(value); }}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{value}</span>
              </button>
            ) : (
              <span className="text-foreground truncate">{value}</span>
            )
          ) : (
            <span className="text-muted-foreground">{placeholder ?? "—"}</span>
          )}
        </div>
      )}
    </div>
  );
}
