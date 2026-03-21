import { useState } from "react";
import { useTaskStore } from "@/store/task-store";
import { Task, TaskType, Severity } from "@/types/jira";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";
import { CloudOff, ExternalLink, Bug, BookOpen, ClipboardList, Info } from "lucide-react";
import { openExternal } from "@/lib/desktop";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { LogWorkModal } from "@/components/LogWorkModal";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMinutes, parseTimeInput } from "@/lib/worklog-time";

const TASK_TYPES: TaskType[] = ["Story", "Bug", "Task"];
const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "NA"];

function TypeIcon({ type }: { type: TaskType | null }) {
  switch (type) {
    case "Bug":
      return <Bug className="h-3.5 w-3.5 text-destructive" />;
    case "Story":
      return <BookOpen className="h-3.5 w-3.5 text-primary" />;
    case "Task":
      return <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return <span className="text-[12px] text-muted-foreground">—</span>;
  }
}

function SeverityBadge({ severity }: { severity: Severity | null }) {
  if (!severity || severity === "NA")
    return <span className="text-[12px] text-muted-foreground">—</span>;
  const colors: Record<string, string> = {
    Critical: "bg-destructive/15 text-destructive",
    High: "bg-warning/15 text-warning",
    Medium: "bg-accent text-accent-foreground",
    Low: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        colors[severity],
      )}
    >
      {severity}
    </span>
  );
}

export function TaskTable() {
  const { selectedTaskId, setSelectedTask, getFilteredTasks } = useTaskStore();
  const tasks = getFilteredTasks();

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[100px] text-[11px] font-semibold uppercase tracking-wider">
                ID
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider">
                Title
              </TableHead>
              <TableHead className="w-[60px] text-center text-[11px] font-semibold uppercase tracking-wider">
                Type
              </TableHead>
              <TableHead className="w-[140px] text-[11px] font-semibold uppercase tracking-wider">
                Status
              </TableHead>
              <TableHead className="w-[90px] text-center text-[11px] font-semibold uppercase tracking-wider">
                Severity
              </TableHead>
              <TableHead className="w-[70px] text-center text-[11px] font-semibold uppercase tracking-wider">
                <div className="flex items-center justify-center gap-1">
                  Story
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 shrink-0 cursor-help text-muted-foreground/60" />
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="max-w-[240px] p-3 text-[12px] leading-relaxed"
                    >
                      <p className="mb-1.5 font-semibold">Estimation Rule</p>
                      <ul className="space-y-1 text-muted-foreground">
                        <li>
                          • Story Point ให้ estimate เฉพาะ{" "}
                          <span className="font-medium text-foreground">Story</span> เท่านั้น
                        </li>
                        <li>
                          • <span className="font-medium text-foreground">Task / Sub-task</span> —
                          ไม่ใส่ Story Point
                        </li>
                        <li>
                          • Track effort รายคน ให้ใช้{" "}
                          <span className="font-medium text-foreground">Time (Log Work)</span> ใน
                          Task แทน
                        </li>
                        <li>• ห้าม Story Point ซ้ำหลายระดับ — velocity จะเปรียบเทียบกันไม่ได้</li>
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </TableHead>
              <TableHead className="w-[80px] text-center text-[11px] font-semibold uppercase tracking-wider">
                Mandays
              </TableHead>
              <TableHead className="w-[120px] text-[11px] font-semibold uppercase tracking-wider">
                Time
              </TableHead>
              <TableHead className="w-[140px] text-[11px] font-semibold uppercase tracking-wider">
                Note
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
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
    </TooltipProvider>
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
  const {
    updateTaskStatus,
    getStatusesForProject,
    getTotalTimeForTask,
    addWorkLog,
    updateTaskType,
    updateTaskSeverity,
    updateTaskNote,
    updateTaskMandays,
  } = useTaskStore();
  const statuses = getStatusesForProject(task.projectId);
  const totalMinutes = getTotalTimeForTask(task.id);

  return (
    <TableRow
      className={cn(
        "group h-10 cursor-pointer transition-colors duration-150",
        task.isDirty && "bg-yellow-50 dark:bg-yellow-900/20",
        isSelected && "border-l-2 border-l-primary bg-primary/5",
      )}
    >
      <TableCell className="py-1.5" onClick={onSelect}>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {task.jiraTaskId}
          </span>
          {!task.isSynced && <CloudOff className="text-warning h-3 w-3" />}
        </div>
      </TableCell>
      <TableCell className="py-1.5" onClick={onSelect}>
        <div className="flex items-center gap-1.5">
          <span className="line-clamp-1 text-[13px] font-medium leading-tight">{task.title}</span>
          {task.refUrl && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (task.refUrl) void openExternal(task.refUrl);
              }}
            >
              <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-primary" />
            </button>
          )}
        </div>
      </TableCell>
      {/* Type */}
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <Select
          value={task.type ?? ""}
          onValueChange={(v) => updateTaskType(task.id, v as TaskType)}
        >
          <SelectTrigger className="h-7 w-full justify-center border-none bg-transparent p-0 shadow-none focus:ring-0 [&>svg]:hidden">
            <SelectValue>
              <TypeIcon type={task.type} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TASK_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-[13px]">
                <div className="flex items-center gap-1.5">
                  <TypeIcon type={t} />
                  {t}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      {/* Status */}
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <Select value={task.status ?? ""} onValueChange={(v) => updateTaskStatus(task.id, v)}>
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
      {/* Severity */}
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <Select
          value={task.severity ?? ""}
          onValueChange={(v) => updateTaskSeverity(task.id, v as Severity)}
        >
          <SelectTrigger className="h-7 w-full justify-center border-none bg-transparent p-0 shadow-none focus:ring-0 [&>svg]:hidden">
            <SelectValue>
              <SeverityBadge severity={task.severity} />
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s} className="text-[13px]">
                <SeverityBadge severity={s} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="py-1.5 text-center" onClick={onSelect}>
        <span className="text-[13px] tabular-nums">{task.storyLevel ?? "—"}</span>
      </TableCell>
      <TableCell className="py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
        <InlineManday taskId={task.id} value={task.mandays} onUpdate={updateTaskMandays} />
      </TableCell>
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {totalMinutes > 0 ? formatMinutes(totalMinutes) : "—"}
          </span>
          <LogWorkModal taskId={task.id} onLog={addWorkLog} variant="inline" />
        </div>
      </TableCell>
      {/* Note */}
      <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
        <InlineNote taskId={task.id} note={task.note} onUpdate={updateTaskNote} />
      </TableCell>
    </TableRow>
  );
}

function InlineManday({
  taskId,
  value,
  onUpdate,
}: {
  taskId: string;
  value: number | null;
  onUpdate: (taskId: string, v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState("");
  const display = value != null ? formatMinutes(Math.round(value * 480)) : "";

  const commit = (inputRaw: string) => {
    setEditing(false);
    if (!inputRaw.trim()) {
      onUpdate(taskId, null);
      return;
    }
    const mins = parseTimeInput(inputRaw);
    if (mins != null) onUpdate(taskId, mins / 480);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        className="h-6 w-full px-1 text-center text-[12px]"
        placeholder="1d 4h"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => commit(raw)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(raw);
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className="cursor-text text-[13px] tabular-nums hover:text-foreground"
      onClick={() => {
        setRaw(display);
        setEditing(true);
      }}
    >
      {display || "—"}
    </span>
  );
}

function InlineNote({
  taskId,
  note,
  onUpdate,
}: {
  taskId: string;
  note: string | null;
  onUpdate: (taskId: string, note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? "");

  if (editing) {
    return (
      <Input
        autoFocus
        className="h-6 px-1 text-[12px]"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          onUpdate(taskId, value.trim() || null);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onUpdate(taskId, value.trim() || null);
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  return (
    <span
      className="line-clamp-1 cursor-text text-[12px] text-muted-foreground hover:text-foreground"
      onClick={() => {
        setValue(note ?? "");
        setEditing(true);
      }}
    >
      {note || "—"}
    </span>
  );
}
