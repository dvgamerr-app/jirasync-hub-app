import { memo, useRef, useState, useMemo, useCallback, type Ref } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTaskStore } from "@/store/task-store";
import { Task, TaskType, Severity } from "@/types/jira";
import { StatusBadge } from "@/components/StatusBadge";
import { AdfRenderer } from "@/components/AdfRenderer";
import { cn } from "@/lib/utils";
import { ExternalLink, Bug, BookOpen, ClipboardList, Info, Zap, FileText } from "lucide-react";
import { openExternal } from "@/lib/desktop";
import { Progress } from "@/components/ui/progress";
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
import { isVisibleWorkLog } from "@/lib/worklog-sync";
import { useShallow } from "zustand/react/shallow";

const TASK_TYPES: TaskType[] = ["Story", "Bug", "Task"];
const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low", "NA"];
const COMPACT_COLUMN_COUNT = 4;
const FULL_COLUMN_COUNT = 9;
const NO_PENDING_MANDAY = Symbol("no-pending-manday");

function hasStoryPointRuleViolation(task: Pick<Task, "type" | "storyLevel">): boolean {
  return task.type !== "Story" && task.storyLevel !== null;
}

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

function isDoneTask(status: string | null | undefined): boolean {
  return status?.trim().toLowerCase() === "done" || status?.trim().toLowerCase() === "closed";
}

type FlatRow =
  | { kind: "epic-header"; epic: Task; subtasks: Task[]; pct: number; totalManday: number; epicTotalMinutes: number }
  | { kind: "epic-desc"; epic: Task }
  | { kind: "task"; task: Task; isSubtask: boolean; isLastSubtask: boolean };

const EpicHeaderRow = memo(function EpicHeaderRow({
  epic,
  subtasks,
  pct,
  totalManday,
  epicTotalMinutes,
  showExtendedColumns,
  descOpen,
  onDescToggle,
  dataIndex,
}: {
  epic: Task;
  subtasks: Task[];
  pct: number;
  totalManday: number;
  epicTotalMinutes: number;
  showExtendedColumns: boolean;
  descOpen: boolean;
  onDescToggle: () => void;
  dataIndex: number;
}) {
  const hasDescription = !!epic.description;

  return (
    <TableRow
      data-index={dataIndex}
      className="border-l-2 border-l-purple-400 bg-purple-50/40 hover:bg-purple-50/60 dark:bg-purple-950/20 dark:hover:bg-purple-950/30"
    >
      <TableCell className="py-2">
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 shrink-0 text-purple-500" />
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {epic.jiraTaskId}
          </span>
        </div>
      </TableCell>
      <TableCell className="py-2">
        <div className="flex items-center gap-1.5">
          <span className="line-clamp-1 text-[13px] font-semibold">{epic.title}</span>
          {epic.refUrl && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openExternal(epic.refUrl!);
              }}
            >
              <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-primary" />
            </button>
          )}
          {hasDescription && (
            <button type="button" onClick={onDescToggle} title={descOpen ? "Hide description" : "Show description"}>
              <FileText
                className={cn(
                  "h-3 w-3 transition-colors",
                  descOpen ? "text-purple-500" : "text-muted-foreground hover:text-primary",
                )}
              />
            </button>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2 text-center">
        <Zap className="mx-auto h-3.5 w-3.5 text-purple-500" />
      </TableCell>
      <TableCell className="py-2">
        <StatusBadge status={epic.status} />
      </TableCell>
      {showExtendedColumns && (
        <>
          <TableCell className="py-2 text-center">
            <span className="text-[12px] text-muted-foreground">—</span>
          </TableCell>
          <TableCell className="py-2 text-center">
            <span className="text-[12px] text-muted-foreground">—</span>
          </TableCell>
          <TableCell className="py-2 text-center">
            <span className="text-[13px] tabular-nums">
              {totalManday > 0 ? formatMandayValue(totalManday) : "—"}
            </span>
          </TableCell>
          <TableCell className="py-2">
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {epicTotalMinutes > 0 ? formatMinutes(epicTotalMinutes) : "—"}
            </span>
          </TableCell>
          <TableCell className="py-2">
            {subtasks.length > 0 && (
              <div className="flex items-center gap-2">
                <Progress value={pct} className="h-1.5 w-16 shrink-0" />
                <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                  {pct}% Done
                </span>
              </div>
            )}
          </TableCell>
        </>
      )}
    </TableRow>
  );
});

export function TaskTable() {
  const { selectedTaskId, getFilteredTasks, workLogs, projects } = useTaskStore();
  const allTasks = getFilteredTasks();
  const showExtendedColumns = !selectedTaskId;
  const colSpanAll = showExtendedColumns ? FULL_COLUMN_COUNT : COMPACT_COLUMN_COUNT;

  const totalMinutesByTaskId = useMemo(
    () =>
      workLogs.filter(isVisibleWorkLog).reduce<Record<string, number>>((acc, wl) => {
        acc[wl.taskId] = (acc[wl.taskId] ?? 0) + wl.timeSpentMinutes;
        return acc;
      }, {}),
    [workLogs],
  );

  const statusesByProjectId = useMemo(
    () => new Map(projects.map((p) => [p.id, p.availableStatuses] as const)),
    [projects],
  );

  const { epicGroups, orphanTasks } = useMemo(() => {
    const epics = allTasks.filter((t) => t.isEpic === true);
    const nonEpics = allTasks.filter((t) => t.isEpic !== true);
    const epicKeySet = new Set(epics.map((e) => e.jiraTaskId));
    const subtasksByEpicKey: Record<string, Task[]> = {};
    const orphans: Task[] = [];
    for (const task of nonEpics) {
      if (task.parentKey && epicKeySet.has(task.parentKey)) {
        subtasksByEpicKey[task.parentKey] ??= [];
        subtasksByEpicKey[task.parentKey].push(task);
      } else {
        orphans.push(task);
      }
    }
    return {
      epicGroups: epics
        .map((epic) => ({ epic, subtasks: subtasksByEpicKey[epic.jiraTaskId] ?? [] }))
        .filter(({ subtasks }) => subtasks.length > 0),
      orphanTasks: orphans,
    };
  }, [allTasks]);

  const [openDescEpics, setOpenDescEpics] = useState<Set<string>>(new Set());
  const toggleDesc = useCallback(
    (epicId: string) =>
      setOpenDescEpics((prev) => {
        const next = new Set(prev);
        next.has(epicId) ? next.delete(epicId) : next.add(epicId);
        return next;
      }),
    [],
  );

  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const { epic, subtasks } of epicGroups) {
      const doneCount = subtasks.filter((t) => isDoneTask(t.status)).length;
      const pct = subtasks.length > 0 ? Math.round((doneCount / subtasks.length) * 100) : 0;
      const totalManday = subtasks.reduce((sum, t) => sum + (t.mandays ?? 0), 0);
      const epicTotalMinutes = subtasks.reduce(
        (sum, t) => sum + (totalMinutesByTaskId[t.id] ?? 0),
        0,
      );
      rows.push({ kind: "epic-header", epic, subtasks, pct, totalManday, epicTotalMinutes });
      if (openDescEpics.has(epic.id) && epic.description) {
        rows.push({ kind: "epic-desc", epic });
      }
      subtasks.forEach((task, idx) =>
        rows.push({ kind: "task", task, isSubtask: true, isLastSubtask: idx === subtasks.length - 1 }),
      );
    }
    for (const task of orphanTasks) {
      rows.push({ kind: "task", task, isSubtask: false, isLastSubtask: false });
    }
    return rows;
  }, [epicGroups, orphanTasks, openDescEpics, totalMinutesByTaskId]);

  const parentRef = useRef<HTMLDivElement>(null);
  const handleSelectTask = useCallback((taskId: string) => {
    const { selectedTaskId: cur, setSelectedTask: set } = useTaskStore.getState();
    set(cur === taskId ? null : taskId);
  }, []);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (flatRows[i].kind === "epic-desc" ? 160 : 40),
    overscan: 12,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0) : 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div ref={parentRef} className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[108px] text-[11px] font-semibold uppercase tracking-wider">
                ID
              </TableHead>
              <TableHead className="text-[11px] font-semibold uppercase tracking-wider">
                Title
              </TableHead>
              <TableHead className="w-[60px] text-center text-[11px] font-semibold uppercase tracking-wider">
                Type
              </TableHead>
              <TableHead className="w-[160px] text-[11px] font-semibold uppercase tracking-wider">
                Status
              </TableHead>
              {showExtendedColumns && (
                <TableHead className="w-[90px] text-center text-[11px] font-semibold uppercase tracking-wider">
                  Severity
                </TableHead>
              )}
              {showExtendedColumns && (
                <TableHead className="w-[70px] text-center text-[11px] font-semibold uppercase tracking-wider">
                  <div className="flex items-center justify-center gap-1">
                    Story
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 shrink-0 cursor-help text-muted-foreground/60" />
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        align="start"
                        className="max-w-[210px] p-2 text-left text-[11px] leading-snug"
                      >
                        <p className="mb-1 font-semibold">Estimation Rule</p>
                        <ul className="space-y-1 text-muted-foreground">
                          <li>
                            • Story Point ให้ estimate เฉพาะ{" "}
                            <span className="font-medium text-foreground">Story</span> เท่านั้น
                          </li>
                          <li>
                            • Track effort รายคน ให้ใช้{" "}
                            <span className="font-medium text-foreground">Time (Log Work)</span> ใน
                            Task
                          </li>
                          <li>• ห้าม Story Point ซ้ำหลายระดับ — velocity จะเปรียบเทียบกันไม่ได้</li>
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
              )}
              {showExtendedColumns && (
                <TableHead className="w-[80px] text-center text-[11px] font-semibold uppercase tracking-wider">
                  Mandays
                </TableHead>
              )}
              {showExtendedColumns && (
                <TableHead className="w-[120px] text-[11px] font-semibold uppercase tracking-wider">
                  Time
                </TableHead>
              )}
              {showExtendedColumns && (
                <TableHead className="w-[140px] text-[11px] font-semibold uppercase tracking-wider">
                  Note
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {flatRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpanAll} className="h-32 text-center text-muted-foreground">
                  No tasks found
                </TableCell>
              </TableRow>
            ) : (
              <>
                {paddingTop > 0 && (
                  <TableRow>
                    <TableCell colSpan={colSpanAll} style={{ height: paddingTop, padding: 0 }} />
                  </TableRow>
                )}
                {virtualItems.map((vRow) => {
                  const row = flatRows[vRow.index];
                  if (row.kind === "epic-header") {
                    return (
                      <EpicHeaderRow
                        key={vRow.key}
                        epic={row.epic}
                        subtasks={row.subtasks}
                        pct={row.pct}
                        totalManday={row.totalManday}
                        epicTotalMinutes={row.epicTotalMinutes}
                        showExtendedColumns={showExtendedColumns}
                        descOpen={openDescEpics.has(row.epic.id)}
                        onDescToggle={() => toggleDesc(row.epic.id)}
                        dataIndex={vRow.index}
                      />
                    );
                  }
                  if (row.kind === "epic-desc") {
                    return (
                      <TableRow
                        key={vRow.key}
                        data-index={vRow.index}
                        ref={virtualizer.measureElement as Ref<HTMLTableRowElement>}
                        className="bg-purple-50/20 hover:bg-purple-50/20 dark:bg-purple-950/10"
                      >
                        <TableCell colSpan={colSpanAll} className="px-10 py-3">
                          <AdfRenderer content={row.epic.description!} />
                        </TableCell>
                      </TableRow>
                    );
                  }
                  return (
                    <TaskRow
                      key={vRow.key}
                      task={row.task}
                      isSelected={row.task.id === selectedTaskId}
                      showExtendedColumns={showExtendedColumns}
                      statuses={statusesByProjectId.get(row.task.projectId) ?? []}
                      totalMinutes={totalMinutesByTaskId[row.task.id] ?? 0}
                      onSelect={handleSelectTask}
                      isSubtask={row.isSubtask}
                      isLastSubtask={row.isLastSubtask}
                      dataIndex={vRow.index}
                    />
                  );
                })}
                {paddingBottom > 0 && (
                  <TableRow>
                    <TableCell colSpan={colSpanAll} style={{ height: paddingBottom, padding: 0 }} />
                  </TableRow>
                )}
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}

const TaskRow = memo(function TaskRow({
  task,
  isSelected,
  showExtendedColumns,
  statuses,
  totalMinutes,
  onSelect,
  isSubtask,
  isLastSubtask,
  dataIndex,
}: {
  task: Task;
  isSelected: boolean;
  showExtendedColumns: boolean;
  statuses: string[];
  totalMinutes: number;
  onSelect: (taskId: string) => void;
  isSubtask?: boolean;
  isLastSubtask?: boolean;
  dataIndex: number;
}) {
  const {
    updateTaskStatus,
    addWorkLog,
    updateTaskType,
    updateTaskSeverity,
    updateTaskNote,
    updateTaskMandays,
  } = useTaskStore(
    useShallow((s) => ({
      updateTaskStatus: s.updateTaskStatus,
      addWorkLog: s.addWorkLog,
      updateTaskType: s.updateTaskType,
      updateTaskSeverity: s.updateTaskSeverity,
      updateTaskNote: s.updateTaskNote,
      updateTaskMandays: s.updateTaskMandays,
    })),
  );
  const hasStoryPointViolation = hasStoryPointRuleViolation(task);

  return (
    <TableRow
      data-index={dataIndex}
      className={cn(
        "group h-10 cursor-pointer transition-colors duration-150",
        hasStoryPointViolation &&
          "bg-red-50/80 hover:bg-red-50 dark:bg-red-950/20 dark:hover:bg-red-950/30",
        task.isDirty && "bg-yellow-50 dark:bg-yellow-900/20",
        isSelected && "border-l-2 border-l-primary bg-primary/5",
      )}
    >
      <TableCell className={cn("relative py-1.5", isSubtask ? "pl-8" : "")} onClick={() => onSelect(task.id)}>
        {isSubtask && (
          <>
            <span
              className="pointer-events-none absolute left-[13px] w-px bg-border"
              style={{ top: 0, bottom: isLastSubtask ? "50%" : 0 }}
            />
            <span
              className="pointer-events-none absolute h-px w-3 bg-border"
              style={{ left: "13px", top: "50%" }}
            />
          </>
        )}
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {task.jiraTaskId}
          </span>

        </div>
      </TableCell>
      <TableCell className="py-1.5" onClick={() => onSelect(task.id)}>
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
      <TableCell className="w-[140px] py-1.5" onClick={(e) => e.stopPropagation()}>
        <Select value={task.status ?? ""} onValueChange={(v) => updateTaskStatus(task.id, v)}>
          <SelectTrigger className="h-7 w-full min-w-0 border-none bg-transparent p-0 text-left shadow-none focus:ring-0 [&>span]:min-w-0 [&>span]:flex-1 [&>svg]:h-3 [&>svg]:w-3">
            <SelectValue>
              <StatusBadge status={task.status} truncate />
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
      {showExtendedColumns && (
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
      )}
      {showExtendedColumns && (
        <TableCell className="py-1.5 text-center" onClick={() => onSelect(task.id)}>
          <span
            className={cn(
              "text-[13px] tabular-nums",
              hasStoryPointViolation && "font-medium text-destructive",
            )}
          >
            {task.storyLevel ?? "—"}
          </span>
        </TableCell>
      )}
      {showExtendedColumns && (
        <TableCell className="py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
          <InlineManday taskId={task.id} value={task.mandays} onUpdate={updateTaskMandays} />
        </TableCell>
      )}
      {showExtendedColumns && (
        <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {totalMinutes > 0 ? formatMinutes(totalMinutes) : "—"}
            </span>
            <LogWorkModal taskId={task.id} onLog={addWorkLog} variant="inline" />
          </div>
        </TableCell>
      )}
      {/* Note */}
      {showExtendedColumns && (
        <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
          <InlineNote taskId={task.id} note={task.note} onUpdate={updateTaskNote} />
        </TableCell>
      )}
    </TableRow>
  );
});

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
  const skipBlurCommitRef = useRef(false);
  const [pendingSourceValue, setPendingSourceValue] = useState<
    number | null | typeof NO_PENDING_MANDAY
  >(NO_PENDING_MANDAY);
  const display = formatMandayValue(value);

  const commit = (inputRaw: string) => {
    setEditing(false);
    const trimmed = inputRaw.trim();

    if (!trimmed) {
      if (value !== null) {
        setPendingSourceValue(value);
        onUpdate(taskId, null);
      }
      return;
    }

    const mins = parseTimeInput(trimmed);
    if (mins == null) {
      setRaw(formatMandayValue(value));
      return;
    }

    const nextValue = mins / 480;
    if (nextValue !== value) {
      setPendingSourceValue(value);
      onUpdate(taskId, nextValue);
    }
  };

  const cancelEditing = () => {
    skipBlurCommitRef.current = true;
    setRaw(display);
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={`Edit mandays for ${taskId}`}
        className={cn(
          "h-6 w-full px-1 text-center text-[12px]",
          pendingSourceValue !== NO_PENDING_MANDAY &&
            value === pendingSourceValue &&
            "border-warning ring-warning/50 ring-1",
        )}
        placeholder="1d 4h"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          if (skipBlurCommitRef.current) {
            skipBlurCommitRef.current = false;
            return;
          }
          commit(raw);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancelEditing();
          }
        }}
      />
    );
  }

  return (
    <span
      className="cursor-text text-[13px] tabular-nums hover:text-foreground"
      onClick={() => {
        setPendingSourceValue(NO_PENDING_MANDAY);
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
  return (
    <InlineNoteEditor
      key={note ?? "__empty__"}
      taskId={taskId}
      initialValue={note ?? ""}
      onUpdate={onUpdate}
    />
  );
}

function InlineNoteEditor({
  taskId,
  initialValue,
  onUpdate,
}: {
  taskId: string;
  initialValue: string;
  onUpdate: (taskId: string, note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialValue);
  const originalRef = useRef(initialValue);
  const skipBlurCommitRef = useRef(false);

  const commit = () => {
    const trimmed = value.trim() || null;
    const originalTrimmed = originalRef.current.trim() || null;

    setEditing(false);
    if (trimmed !== originalTrimmed) {
      onUpdate(taskId, trimmed);
    }
  };

  const cancelEditing = () => {
    skipBlurCommitRef.current = true;
    setValue(originalRef.current);
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={`Edit note for ${taskId}`}
        className="h-6 px-1 text-[12px]"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (skipBlurCommitRef.current) {
            skipBlurCommitRef.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            cancelEditing();
          }
        }}
      />
    );
  }

  return (
    <span
      className="line-clamp-1 cursor-text text-[12px] text-muted-foreground hover:text-foreground"
      onClick={() => {
        setValue(initialValue);
        setEditing(true);
      }}
    >
      {initialValue || "—"}
    </span>
  );
}

function formatMandayValue(value: number | null): string {
  return value != null ? formatMinutes(Math.round(value * 480)) : "";
}
