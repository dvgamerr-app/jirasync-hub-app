import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { format } from "date-fns";
import { Check, Clipboard, Download } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { fetchJiraMyselfDisplayName } from "@/lib/jira-api";
import { getJiraAccounts, type JiraAccount } from "@/lib/jira-db";
import { getAccountIdFromTask } from "@/lib/jira-ids";
import { isVisibleWorkLog } from "@/lib/worklog-sync";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import type { Project, Task, WorkLog } from "@/types/jira";

const CSV_HEADER = [
  "FullName",
  "Project",
  "Month",
  "Year",
  "Type",
  "Story Point",
  "Severity",
  "Usage Time (min)",
  "Ref URL",
  "Note",
];

const MINUTES_PER_MANDAY = 8 * 60;

function formatMinutesLong(minutes: number): string {
  const WEEK = 5 * 8 * 60; // 2400 min
  const DAY = MINUTES_PER_MANDAY;
  const w = Math.floor(minutes / WEEK);
  const d = Math.floor((minutes % WEEK) / DAY);
  const h = Math.floor((minutes % DAY) / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (w > 0) parts.push(`${w}w`);
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}

type ExportRow = {
  accountId: string | null;
  periodLabel: string;
  periodMonth: string;
  periodYear: string;
  periodValue: string;
  projectName: string;
  taskId: string;
  note: string;
  refUrl: string;
  severity: string;
  storyPoint: string;
  timeSpentMinutes: number;
  type: string;
};

type ExportPeriod = {
  label: string;
  value: string;
};

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  tasks: Task[];
  workLogs: WorkLog[];
}

function escapeCsvValue(value: string): string {
  return value.includes(",") || value.includes('"') || value.includes("\n")
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function buildTableRows(
  rows: ExportRow[],
  fullNamesByAccountId: Record<string, string>,
): string[][] {
  return [
    CSV_HEADER,
    ...rows.map((row) => [
      row.accountId ? (fullNamesByAccountId[row.accountId] ?? "") : "",
      row.projectName,
      row.periodMonth,
      row.periodYear,
      row.type,
      row.storyPoint,
      row.severity,
      row.timeSpentMinutes.toString(),
      row.refUrl,
      row.note,
    ]),
  ];
}

function buildCsv(rows: ExportRow[], fullNamesByAccountId: Record<string, string>): string {
  return buildTableRows(rows, fullNamesByAccountId)
    .map((row) => row.map(escapeCsvValue).join(","))
    .join("\n");
}

async function getFullNamesByAccountId(rows: ExportRow[]): Promise<Record<string, string>> {
  const accountsById = new Map(getJiraAccounts().map((account) => [account.id, account]));
  const accountIds = Array.from(
    new Set(
      rows
        .map((row) => row.accountId)
        .filter((accountId): accountId is string => accountId !== null),
    ),
  );

  const entries = await Promise.all(
    accountIds.map(async (accountId) => {
      const account = accountsById.get(accountId);
      if (!account) {
        return [accountId, ""] as const;
      }

      return [accountId, await getPreferredFullName(account)] as const;
    }),
  );

  return Object.fromEntries(entries);
}

async function getPreferredFullName(account: JiraAccount): Promise<string> {
  try {
    return await fetchJiraMyselfDisplayName(account);
  } catch {
    return account.name || account.email;
  }
}

function createExportRows(tasks: Task[], workLogs: WorkLog[], projects: Project[]): ExportRow[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const projectById = new Map(projects.map((project) => [project.id, project]));

  const rowMap = new Map<string, ExportRow>();

  for (const log of workLogs.filter(isVisibleWorkLog)) {
    const task = taskById.get(log.taskId);
    if (!task) continue;

    const date = new Date(log.logDate);
    if (Number.isNaN(date.getTime())) continue;

    const periodValue = format(date, "yyyy-MM");
    const key = `${task.id}::${periodValue}`;

    const existing = rowMap.get(key);
    if (existing) {
      existing.timeSpentMinutes += log.timeSpentMinutes;
    } else {
      const project = projectById.get(task.projectId);
      rowMap.set(key, {
        accountId: getAccountIdFromTask(task),
        periodLabel: format(date, "yyyy-MMM"),
        periodMonth: format(date, "MMM"),
        periodYear: format(date, "yyyy"),
        periodValue,
        projectName: project?.name ?? "",
        taskId: task.id,
        note: task.note ?? "",
        refUrl: task.refUrl ?? "",
        severity: task.severity ?? "NA",
        storyPoint: task.storyLevel?.toString() ?? "",
        timeSpentMinutes: log.timeSpentMinutes,
        type: task.type ?? "",
      });
    }
  }

  return Array.from(rowMap.values());
}

function comparePeriodValuesDescending(left: string, right: string): number {
  return right.localeCompare(left);
}

function getExportPeriods(rows: ExportRow[]): ExportPeriod[] {
  const periodsByValue = new Map<string, ExportPeriod>();

  rows.forEach((row) => {
    periodsByValue.set(row.periodValue, {
      label: row.periodLabel,
      value: row.periodValue,
    });
  });

  return Array.from(periodsByValue.values()).sort((left, right) =>
    comparePeriodValuesDescending(left.value, right.value),
  );
}

function getExportFileName(periodLabel: string): string {
  return `jirasync-export-${periodLabel}.csv`;
}

function getDisplayFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

function workingDaysInMonth(yearMonth: string): number {
  const [year, month] = yearMonth.split("-").map(Number);
  const date = new Date(year, month - 1, 1);
  let count = 0;
  while (date.getMonth() === month - 1) {
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) count++;
    date.setDate(date.getDate() + 1);
  }
  return count;
}

function calculateMandayMinutesForPeriod(
  tasks: Task[],
  rows: ExportRow[],
  periodValue: string,
): number {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskMinutes = new Map<string, { total: number; inPeriod: number }>();

  rows.forEach((row) => {
    const entry = taskMinutes.get(row.taskId) ?? { total: 0, inPeriod: 0 };
    entry.total += row.timeSpentMinutes;
    if (row.periodValue === periodValue) entry.inPeriod += row.timeSpentMinutes;
    taskMinutes.set(row.taskId, entry);
  });

  return Math.round(
    Array.from(taskMinutes.entries()).reduce((sum, [taskId, minutes]) => {
      const taskMandayMinutes = (taskById.get(taskId)?.mandays ?? 0) * MINUTES_PER_MANDAY;

      if (minutes.total <= 0 || minutes.inPeriod <= 0 || taskMandayMinutes <= 0) return sum;

      return sum + taskMandayMinutes * (minutes.inPeriod / minutes.total);
    }, 0),
  );
}

const SPEED_RATE_OK = 0.8;

export function ExportDialog({ open, onOpenChange, projects, tasks, workLogs }: ExportDialogProps) {
  const exportRows = useMemo(
    () => createExportRows(tasks, workLogs, projects),
    [tasks, workLogs, projects],
  );
  const exportPeriods = useMemo(() => getExportPeriods(exportRows), [exportRows]);
  const latestPeriod = exportPeriods[0] ?? null;
  const [selectedPeriodValue, setSelectedPeriodValue] = useState(latestPeriod?.value ?? "");
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [savedFileName, setSavedFileName] = useState("");
  const [savedFilePath, setSavedFilePath] = useState("");
  const [savedPeriodValue, setSavedPeriodValue] = useState("");
  const [copiedPeriodValue, setCopiedPeriodValue] = useState("");

  useEffect(() => {
    if (!open) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedPeriodValue(exportPeriods[0]?.value ?? "");
    setSavedFileName("");
    setSavedFilePath("");
    setSavedPeriodValue("");
    setCopiedPeriodValue("");
  }, [open, exportPeriods]);

  const { matchingRows, totalMinutes, capacityMinutes, totalMandayMinutes } = useMemo(() => {
    const rows = exportRows.filter((row) => row.periodValue === selectedPeriodValue);
    return {
      matchingRows: rows,
      totalMinutes: rows.reduce((sum, row) => sum + row.timeSpentMinutes, 0),
      capacityMinutes: workingDaysInMonth(selectedPeriodValue) * MINUTES_PER_MANDAY,
      totalMandayMinutes: calculateMandayMinutesForPeriod(tasks, exportRows, selectedPeriodValue),
    };
  }, [exportRows, selectedPeriodValue, tasks]);
  const selectedPeriodLabel =
    exportPeriods.find((period) => period.value === selectedPeriodValue)?.label ?? "";
  const hasSavedCurrentPeriod = Boolean(savedFileName) && savedPeriodValue === selectedPeriodValue;
  const hasCopiedCurrentPeriod = copiedPeriodValue === selectedPeriodValue;

  const chartData = useMemo(() => {
    const byMonth = new Map<string, { label: string; loggedMin: number }>();
    for (const row of exportRows) {
      const entry = byMonth.get(row.periodValue) ?? { label: row.periodLabel, loggedMin: 0 };
      entry.loggedMin += row.timeSpentMinutes;
      byMonth.set(row.periodValue, entry);
    }
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([value, v]) => {
        if (v.loggedMin <= 0) return [];
        const cap = workingDaysInMonth(value) * MINUTES_PER_MANDAY;
        return [
          {
            value,
            month: v.label.replace(/^\d{4}-/, ""),
            speed: Math.round((v.loggedMin / cap) * 1000) / 10,
          },
        ];
      });
  }, [exportRows]);

  const handleCopy = async () => {
    if (copying || matchingRows.length === 0) return;

    setCopying(true);

    try {
      const fullNamesByAccountId = await getFullNamesByAccountId(matchingRows);
      const [, ...dataRows] = buildTableRows(matchingRows, fullNamesByAccountId);
      const tsvContent = dataRows
        .map((row) => row.map((v) => v.replace(/\t/g, " ")).join("\t"))
        .join("\n");
      const htmlContent = `<table>${dataRows.map((row) => `<tr>${row.map((v) => `<td>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td>`).join("")}</tr>`).join("")}</table>`;
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([tsvContent], { type: "text/plain" }),
          "text/html": new Blob([htmlContent], { type: "text/html" }),
        }),
      ]);

      setCopiedPeriodValue(selectedPeriodValue);
      toast({
        title: "Copied to clipboard",
        description: `${matchingRows.length} worklog(s) copied as CSV`,
      });
    } catch (error) {
      toast({
        title: "Copy failed",
        description: error instanceof Error ? error.message : "Could not copy to clipboard",
        variant: "destructive",
      });
    } finally {
      setCopying(false);
    }
  };

  const handleExport = async () => {
    if (exporting || matchingRows.length === 0) return;

    setExporting(true);

    try {
      const filePath = await save({
        defaultPath: getExportFileName(selectedPeriodLabel),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });

      if (!filePath) return;

      const fileName = getDisplayFileName(filePath);
      const fullNamesByAccountId = await getFullNamesByAccountId(matchingRows);
      const csvContent = buildCsv(matchingRows, fullNamesByAccountId);
      await writeTextFile(filePath, csvContent);

      setSavedFileName(fileName);
      setSavedFilePath(filePath);
      setSavedPeriodValue(selectedPeriodValue);
      toast({
        title: "Export complete",
        description: (
          <span>
            {matchingRows.length} worklog(s) saved to{" "}
            <button
              type="button"
              className="underline hover:no-underline"
              onClick={() => openPath(filePath)}
            >
              {fileName}
            </button>
          </span>
        ),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Could not save the CSV file",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export CSV</DialogTitle>
          <DialogDescription>
            Choose the month from Time Tracking, then pick where the CSV file should be saved.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="export-period">Month</Label>
            <Select value={selectedPeriodValue} onValueChange={setSelectedPeriodValue}>
              <SelectTrigger id="export-period">
                <SelectValue placeholder="Select month" />
              </SelectTrigger>
              <SelectContent>
                {exportPeriods.map((period) => (
                  <SelectItem key={period.value} value={period.value}>
                    {period.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            className={`rounded-lg border px-3 py-3 ${hasSavedCurrentPeriod ? "border-green-500/40 bg-green-500/10" : "bg-muted/40"}`}
          >
            <p className="text-sm font-medium">
              {matchingRows.length > 0
                ? `${matchingRows.length} worklog(s) ready to export`
                : "No worklogs found for this month"}
            </p>
            {matchingRows.length > 0 && (
              <>
                <p className="text-muted-foreground mt-1 text-xs">
                  Total logged time: {formatMinutesLong(totalMinutes)}
                </p>
                {totalMandayMinutes > 0 && (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Total manday: {formatMinutesLong(totalMandayMinutes)}
                  </p>
                )}
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Capacity: {workingDaysInMonth(selectedPeriodValue)} working days
                </p>
                <p className="mt-0.5 text-xs font-medium">
                  Speed rate:{" "}
                  <span
                    className={
                      totalMinutes / capacityMinutes >= SPEED_RATE_OK
                        ? "text-green-600 dark:text-green-400"
                        : "text-amber-600 dark:text-amber-400"
                    }
                  >
                    {Math.round((totalMinutes / capacityMinutes) * 1000) / 10}%
                  </span>
                </p>
              </>
            )}
            {matchingRows.length === 0 && (
              <p className="text-muted-foreground mt-1 text-xs">
                Select another month from Time Tracking to export.
              </p>
            )}
            {hasSavedCurrentPeriod && (
              <p className="mt-2 text-xs font-medium text-green-700 dark:text-green-400">
                Saved to{" "}
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={() => openPath(savedFilePath)}
                >
                  {savedFileName}
                </button>
              </p>
            )}
          </div>

          {chartData.length > 1 && (
            <div>
              <p className="text-muted-foreground mb-1 text-[11px]">Speed rate % / month</p>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={chartData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--border))"
                  />
                  <XAxis dataKey="month" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                  <ReferenceLine
                    y={100}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 3"
                    strokeOpacity={0.5}
                  />
                  <Tooltip
                    formatter={(v) => [`${v}%`, "Speed"]}
                    contentStyle={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: "6px",
                      backgroundColor: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                      borderColor: "hsl(var(--border))",
                    }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="speed"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={(props) => {
                      const { cx, cy, payload } = props as {
                        cx: number;
                        cy: number;
                        payload: { value: string; speed: number };
                      };
                      const isSelected = payload.value === selectedPeriodValue;
                      return (
                        <circle
                          key={payload.value}
                          cx={cx}
                          cy={cy}
                          r={isSelected ? 4 : 2.5}
                          fill={isSelected ? "hsl(var(--primary))" : "hsl(var(--background))"}
                          stroke="hsl(var(--primary))"
                          strokeWidth={isSelected ? 0 : 2}
                        />
                      );
                    }}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
              <p className="text-muted-foreground/60 mt-1 text-[10px]">
                Speed rate = logged ÷ (working days × 8h) × 100
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={exporting || copying}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleCopy()}
            disabled={copying || exporting || matchingRows.length === 0}
          >
            {hasCopiedCurrentPeriod && !copying ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Clipboard className="h-4 w-4" />
            )}
            {copying ? "Copying..." : "Copy CSV"}
          </Button>
          <Button
            onClick={() => void handleExport()}
            disabled={exporting || copying || matchingRows.length === 0}
          >
            {hasSavedCurrentPeriod && !exporting ? (
              <Check className="animate-check-pop h-4 w-4 text-green-500" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting ? "Saving..." : "Save CSV"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
