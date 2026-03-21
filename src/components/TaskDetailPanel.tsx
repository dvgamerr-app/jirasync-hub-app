import { useState } from "react";
import { useTaskStore } from "@/store/task-store";
import { StatusBadge } from "@/components/StatusBadge";
import { StoryLevel } from "@/types/jira";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { X, Clock, CalendarIcon, CloudOff, Cloud } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

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
    addWorkLog,
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
            <LogTimePopover taskId={task.id} onLog={addWorkLog} />
          </div>

          {/* Total time */}
          {workLogs.length > 0 && (
            <div className="text-[12px] text-muted-foreground">
              Total: {formatMinutes(workLogs.reduce((sum, wl) => sum + wl.timeSpentMinutes, 0))}
            </div>
          )}

          {/* Work Log List */}
          <div className="space-y-2">
            {workLogs.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No work logged yet</p>
            ) : (
              workLogs.map((wl) => (
                <div key={wl.id} className="rounded-md border border-border bg-muted/20 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium tabular-nums">{formatMinutes(wl.timeSpentMinutes)}</span>
                    <span className="text-[11px] text-muted-foreground">{wl.logDate}</span>
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

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function LogTimePopover({
  taskId,
  onLog,
}: {
  taskId: string;
  onLog: (log: { taskId: string; timeSpentMinutes: number; logDate: string; comment: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [timeInput, setTimeInput] = useState("");
  const [date, setDate] = useState<Date>(new Date());
  const [comment, setComment] = useState("");

  const handleSubmit = () => {
    const minutes = parseTimeInput(timeInput);
    if (!minutes || minutes <= 0) {
      toast({ title: "Invalid time", description: "Enter time like '2h 30m' or '90m'", variant: "destructive" });
      return;
    }
    onLog({
      taskId,
      timeSpentMinutes: minutes,
      logDate: format(date, "yyyy-MM-dd"),
      comment: comment.trim() || null,
    });
    setTimeInput("");
    setComment("");
    setOpen(false);
    toast({ title: "Time logged", description: `${formatMinutes(minutes)} logged successfully` });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[12px]">
          Log Time
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="end">
        <h4 className="text-[13px] font-semibold">Log Work</h4>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Time Spent</label>
          <Input
            placeholder="e.g. 2h 30m"
            className="h-8 text-[13px]"
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Date</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-8 w-full justify-start text-[13px] font-normal">
                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                {format(date, "PPP")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={date}
                onSelect={(d) => d && setDate(d)}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Comment</label>
          <Textarea
            placeholder="What did you work on?"
            className="min-h-[60px] text-[13px]"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <Button onClick={handleSubmit} className="h-8 w-full text-[13px]">
          Log Work
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function parseTimeInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  let totalMinutes = 0;
  const hourMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*h/);
  const minMatch = trimmed.match(/(\d+)\s*m/);

  if (hourMatch) totalMinutes += parseFloat(hourMatch[1]) * 60;
  if (minMatch) totalMinutes += parseInt(minMatch[1]);

  if (!hourMatch && !minMatch) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) totalMinutes = num * 60;
    else return null;
  }

  return Math.round(totalMinutes);
}
