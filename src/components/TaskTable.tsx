import { useState } from "react";
import { useTaskStore } from "@/store/task-store";
import { Task } from "@/types/jira";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import { CloudOff, Plus, Clock } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
import { toast } from "@/hooks/use-toast";

export function TaskTable() {
  const { selectedTaskId, setSelectedTask, getFilteredTasks } = useTaskStore();
  const tasks = getFilteredTasks();

  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[100px] text-[11px] font-semibold uppercase tracking-wider">ID</TableHead>
            <TableHead className="text-[11px] font-semibold uppercase tracking-wider">Title</TableHead>
            <TableHead className="w-[140px] text-[11px] font-semibold uppercase tracking-wider">Status</TableHead>
            <TableHead className="w-[70px] text-center text-[11px] font-semibold uppercase tracking-wider">Story</TableHead>
            <TableHead className="w-[80px] text-center text-[11px] font-semibold uppercase tracking-wider">Mandays</TableHead>
            <TableHead className="w-[120px] text-[11px] font-semibold uppercase tracking-wider">Time</TableHead>
            <TableHead className="w-[100px] text-[11px] font-semibold uppercase tracking-wider">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                No tasks found
              </TableCell>
            </TableRow>
          ) : (
            tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isSelected={task.id === selectedTaskId}
                onSelect={() => setSelectedTask(task.id === selectedTaskId ? null : task.id)}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function TaskRow({
  task,
  isSelected,
  onSelect,
}: {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { updateTaskStatus, getStatusesForProject, getTotalTimeForTask, addWorkLog } = useTaskStore();
  const statuses = getStatusesForProject(task.projectId);
  const totalMinutes = getTotalTimeForTask(task.id);

  return (
    <TableRow
      className={cn(
        "group h-10 cursor-pointer transition-colors duration-150",
        isSelected && "bg-primary/5 border-l-2 border-l-primary"
      )}
    >
      <TableCell className="py-1.5" onClick={onSelect}>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {task.jiraTaskId}
          </span>
          {!task.isSynced && <CloudOff className="h-3 w-3 text-warning" />}
        </div>
      </TableCell>
      <TableCell className="py-1.5" onClick={onSelect}>
        <span className="text-[13px] font-medium leading-tight line-clamp-1">
          {task.title}
        </span>
      </TableCell>
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <Select
          value={task.status ?? ""}
          onValueChange={(v) => updateTaskStatus(task.id, v)}
        >
          <SelectTrigger className="h-7 w-full border-none bg-transparent p-0 shadow-none focus:ring-0 [&>svg]:h-3 [&>svg]:w-3">
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
      </TableCell>
      <TableCell className="py-1.5 text-center" onClick={onSelect}>
        <span className="text-[13px] tabular-nums">{task.storyLevel ?? "—"}</span>
      </TableCell>
      <TableCell className="py-1.5 text-center" onClick={onSelect}>
        <span className="text-[13px] tabular-nums">{task.mandays ?? "—"}</span>
      </TableCell>
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {totalMinutes > 0 ? formatMinutes(totalMinutes) : "—"}
          </span>
          <InlineLogTime taskId={task.id} onLog={addWorkLog} />
        </div>
      </TableCell>
      <TableCell className="py-1.5" onClick={onSelect}>
        <span className="text-[11px] text-muted-foreground">
          {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
        </span>
      </TableCell>
    </TableRow>
  );
}

function InlineLogTime({
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
    toast({ title: "Time logged", description: `${formatMinutes(minutes)} logged` });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover:opacity-100">
          <Plus className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-3" align="end">
        <h4 className="text-[13px] font-semibold">Log Work</h4>
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Time Spent</label>
          <Input placeholder="e.g. 2h 30m" className="h-8 text-[13px]" value={timeInput} onChange={(e) => setTimeInput(e.target.value)} />
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
              <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} initialFocus className={cn("p-3 pointer-events-auto")} />
            </PopoverContent>
          </Popover>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Comment</label>
          <Textarea placeholder="What did you work on?" className="min-h-[50px] text-[13px]" value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <Button onClick={handleSubmit} className="h-8 w-full text-[13px]">Log Work</Button>
      </PopoverContent>
    </Popover>
  );
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
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
