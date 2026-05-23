import { useState, useRef, useEffect } from "react";
import { useTaskStore } from "@/store/task-store";
import { useShallow } from "zustand/react/shallow";
import { StatusBadge } from "@/components/StatusBadge";
import { StoryLevel, TaskType, Severity } from "@/types/jira";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  X,
  Clock,
  CloudOff,
  Cloud,
  CloudUpload,
  ExternalLink,
  Bug,
  BookOpen,
  ClipboardList,
  Trash2,
} from "lucide-react";
import { format as formatDate, formatDistanceToNow } from "date-fns";
import { toast } from "@/hooks/use-toast";
import { openExternal } from "@/lib/desktop";
import { hasAdfContent } from "@/lib/adf-content";
import { LogWorkModal } from "@/components/LogWorkModal";
import { AdfRenderer } from "@/components/AdfRenderer";
import { formatMandays, formatMinutes, parseTimeInput } from "@/lib/worklog-time";
import { cn } from "@/lib/utils";

const TASK_TYPES: TaskType[] = ["Story", "Bug", "Task"];
const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "NA"];
const NO_PENDING_MANDAY = Symbol("no-pending-manday");
const STORY_LEVEL_OPTIONS: StoryLevel[] = [1, 2, 3, 5];

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
    updateTaskNote,
    addWorkLog,
    removeWorkLog,
    syncTaskToJira,
    taskDetailViewMode,
    setTaskDetailViewMode,
  } = useTaskStore(
    useShallow((s) => ({
      selectedTaskId: s.selectedTaskId,
      setSelectedTask: s.setSelectedTask,
      getTaskById: s.getTaskById,
      getProjectById: s.getProjectById,
      getStatusesForProject: s.getStatusesForProject,
      getWorkLogsForTask: s.getWorkLogsForTask,
      updateTaskStatus: s.updateTaskStatus,
      updateTaskStoryLevel: s.updateTaskStoryLevel,
      updateTaskMandays: s.updateTaskMandays,
      updateTaskType: s.updateTaskType,
      updateTaskSeverity: s.updateTaskSeverity,
      updateTaskNote: s.updateTaskNote,
      addWorkLog: s.addWorkLog,
      removeWorkLog: s.removeWorkLog,
      syncTaskToJira: s.syncTaskToJira,
      taskDetailViewMode: s.taskDetailViewMode,
      setTaskDetailViewMode: s.setTaskDetailViewMode,
    })),
  );

  if (!selectedTaskId) return null;

  const task = getTaskById(selectedTaskId);
  if (!task) return null;

  const project = getProjectById(task.projectId);
  const statuses = getStatusesForProject(task.projectId);
  const workLogs = getWorkLogsForTask(task.id);
  const hasDescription = hasAdfContent(task.description);
  const activeView =
    hasDescription && taskDetailViewMode === "description" ? "description" : "details";
  const canAssignStoryLevel = task.type === "Story";
  const hasInvalidStoryLevel = task.storyLevel !== null && !canAssignStoryLevel;

  const detailContent = (
    <>
      {/* Fields Grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* Type */}
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
            Type
          </label>
          <Select
            value={task.type ?? ""}
            onValueChange={(v) => updateTaskType(task.id, v as TaskType)}
          >
            <SelectTrigger className="h-8 text-[13px]">
              <SelectValue placeholder="—">
                <div className="flex items-center gap-1.5">
                  {task.type === "Bug" && <Bug className="text-destructive h-3.5 w-3.5" />}
                  {task.type === "Story" && <BookOpen className="text-primary h-3.5 w-3.5" />}
                  {task.type === "Task" && (
                    <ClipboardList className="text-muted-foreground h-3.5 w-3.5" />
                  )}
                  {task.type}
                </div>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {TASK_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="text-[13px]">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Severity */}
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
            Severity
          </label>
          <Select
            value={task.severity ?? ""}
            onValueChange={(v) => updateTaskSeverity(task.id, v as Severity)}
          >
            <SelectTrigger className="h-8 text-[13px]">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {SEVERITIES.map((s) => (
                <SelectItem key={s} value={s} className="text-[13px]">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Status */}
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
            Status
          </label>
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
          <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
            Story Level
          </label>
          <Select
            value={task.storyLevel?.toString() ?? "__none__"}
            onValueChange={(v) => {
              const nextLevel = (v === "__none__" ? null : Number(v)) as StoryLevel | null;
              if (nextLevel !== null && !canAssignStoryLevel) {
                return;
              }
              updateTaskStoryLevel(task.id, nextLevel);
            }}
            disabled={!canAssignStoryLevel && task.storyLevel === null}
          >
            <SelectTrigger
              className={cn(
                "h-8 text-[13px]",
                hasInvalidStoryLevel && "border-destructive/40 bg-destructive/5 text-destructive",
              )}
            >
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__" className="text-muted-foreground text-[13px]">
                —
              </SelectItem>
              {hasInvalidStoryLevel && (
                <SelectItem
                  value={task.storyLevel!.toString()}
                  className="text-destructive text-[13px]"
                >
                  {task.storyLevel}
                </SelectItem>
              )}
              {canAssignStoryLevel &&
                STORY_LEVEL_OPTIONS.map((l) => (
                  <SelectItem key={l} value={l.toString()} className="text-[13px]">
                    {l}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {!canAssignStoryLevel && (
            <p
              className={cn(
                "text-muted-foreground text-[11px]",
                hasInvalidStoryLevel && "text-destructive",
              )}
            >
              {hasInvalidStoryLevel
                ? "Only Story tasks can keep Story Level. Clear it or change type to Story."
                : "Story Level can be set only when type is Story."}
            </p>
          )}
        </div>

        {/* Mandays */}
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
            Mandays
          </label>
          <MandayInput value={task.mandays} onSave={(v) => updateTaskMandays(task.id, v)} />
        </div>

        {/* Assignee */}
        <div className="space-y-1.5">
          <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
            Assignee
          </label>
          <div className="border-input bg-background text-muted-foreground flex h-8 items-center rounded-md border px-3 text-[13px]">
            {task.assignee ?? "—"}
          </div>
        </div>
      </div>

      {/* Note */}
      <NoteField value={task.note} onSave={(v) => updateTaskNote(task.id, v)} />

      {/* Timestamps */}
      <div className="text-muted-foreground flex gap-4 text-[11px]">
        <span>Created {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}</span>
        <span>Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}</span>
      </div>

      {/* Time Tracking */}
      <div className="border-border space-y-3 border-t pt-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Clock className="text-muted-foreground h-3.5 w-3.5" />
            Time Tracking
          </h3>
          <LogWorkModal taskId={task.id} onLog={addWorkLog} variant="button" />
        </div>

        {workLogs.length > 0 && (
          <div className="text-muted-foreground text-[12px]">
            Total: {formatMinutes(workLogs.reduce((sum, wl) => sum + wl.timeSpentMinutes, 0))}
          </div>
        )}

        <div className="space-y-2">
          {workLogs.length === 0 ? (
            <p className="text-muted-foreground text-[12px]">No work logged yet</p>
          ) : (
            workLogs.map((wl) => (
              <div key={wl.id} className="border-border bg-muted/20 rounded-md border px-3 py-2">
                <div className="text-muted-foreground mb-2 text-[11px]">
                  {formatWorkLogDate(wl.logDate)}
                </div>

                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <span className="text-[12px] font-medium tabular-nums">
                      {formatMinutes(wl.timeSpentMinutes)}
                    </span>
                    {wl.comment && (
                      <p className="text-muted-foreground text-[12px]">{wl.comment}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive mt-0.5"
                    onClick={() => removeWorkLog(wl.id)}
                    title="Delete work log"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );

  const descriptionContent = hasDescription ? (
    <AdfRenderer content={task.description ?? ""} className="text-muted-foreground" />
  ) : null;

  return (
    <div className="animate-slide-in-right border-border bg-card flex h-full w-full flex-col border-l md:w-[45vw] md:max-w-[600px] md:min-w-[360px]">
      {/* Header — sticky by flex-col layout */}
      <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Task ID as clickable link with project name */}
          <button
            type="button"
            className="text-muted-foreground hover:text-primary flex min-w-0 items-center gap-1 rounded"
            onClick={() => {
              if (task.refUrl) void openExternal(task.refUrl);
            }}
            title={task.refUrl ?? undefined}
          >
            {project && (
              <span className="text-muted-foreground/70 shrink-0 text-[11px]">
                {project.name}&nbsp;·&nbsp;
              </span>
            )}
            <span className="font-mono text-[12px] tabular-nums">{task.jiraTaskId}</span>
            {task.refUrl && <ExternalLink className="ml-0.5 h-3 w-3 shrink-0" />}
          </button>
          {task.isSynced ? (
            <Cloud className="text-success h-3.5 w-3.5 shrink-0" />
          ) : (
            <CloudOff className="text-warning h-3.5 w-3.5 shrink-0" />
          )}
          {task.isDirty && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={async () => {
                try {
                  await syncTaskToJira(task.id);
                } catch {
                  toast({
                    title: "Sync failed",
                    description: `Could not sync ${task.jiraTaskId}`,
                    variant: "destructive",
                  });
                }
              }}
            >
              <CloudUpload className="h-3 w-3" />
              Sync
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setSelectedTask(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-border flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
        <h2 className="min-w-0 flex-1 text-base leading-snug font-semibold">{task.title}</h2>
        {hasDescription && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() =>
              setTaskDetailViewMode(activeView === "description" ? "details" : "description")
            }
          >
            {activeView === "description" ? "Hide Description" : "Show Description"}
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-5">
          {activeView === "description" ? descriptionContent : detailContent}
        </div>
      </div>
    </div>
  );
}

function MandayInput({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  const [pendingSourceValue, setPendingSourceValue] = useState<
    number | null | typeof NO_PENDING_MANDAY
  >(NO_PENDING_MANDAY);
  const display = formatMandays(value);
  const dirty = pendingSourceValue !== NO_PENDING_MANDAY && value === pendingSourceValue;

  const commit = (inputRaw: string) => {
    setEditing(false);
    if (!inputRaw.trim()) {
      if (value !== null) setPendingSourceValue(value);
      onSave(null);
      return;
    }
    const mins = parseTimeInput(inputRaw);
    if (mins != null) {
      const newVal = mins / 480;
      if (newVal !== value) {
        setPendingSourceValue(value);
      }
      onSave(newVal);
    }
  };

  return (
    <Input
      className={`h-8 text-[13px] ${dirty ? "border-warning ring-warning/50 ring-1" : ""}`}
      placeholder="e.g. 1d 4h 30m"
      value={editing ? raw : display}
      onFocus={() => {
        setPendingSourceValue(NO_PENDING_MANDAY);
        setRaw(display);
        setEditing(true);
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => commit(raw)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLElement).blur();
        }
        if (e.key === "Escape") {
          setRaw(display);
          setEditing(false);
        }
      }}
    />
  );
}

function NoteField({
  value,
  onSave,
}: {
  value: string | null;
  onSave: (v: string | null) => void;
}) {
  return <NoteFieldEditor initialValue={value ?? ""} onSave={onSave} />;
}

function NoteFieldEditor({
  initialValue,
  onSave,
}: {
  initialValue: string;
  onSave: (v: string | null) => void;
}) {
  const [current, setCurrent] = useState(initialValue);
  const originalRef = useRef(initialValue);
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setCurrent(initialValue);
      originalRef.current = initialValue;
    }
  }, [initialValue]);

  const commit = () => {
    const trimmed = current.trim() || null;
    const originalTrimmed = originalRef.current.trim() || null;
    if (trimmed !== originalTrimmed) {
      onSave(trimmed);
      originalRef.current = current;
    }
  };

  return (
    <div className="space-y-1.5">
      <label className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
        Note
      </label>
      <Textarea
        className="resize-none text-[13px]"
        rows={2}
        value={current}
        placeholder="Add a note..."
        onChange={(e) => setCurrent(e.target.value)}
        onFocus={() => {
          isFocusedRef.current = true;
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setCurrent(originalRef.current);
          }
        }}
      />
    </div>
  );
}

function formatWorkLogDate(logDate: string): string {
  const parsedDate = new Date(logDate);
  return Number.isNaN(parsedDate.getTime()) ? logDate : formatDate(parsedDate, "d MMM yyyy");
}
