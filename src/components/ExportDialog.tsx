import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Check, Download } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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

function formatMinutesLong(minutes: number): string {
  const WEEK = 5 * 8 * 60; // 2400 min
  const DAY = 8 * 60; // 480 min
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

function buildCsv(rows: ExportRow[], fullNamesByAccountId: Record<string, string>): string {
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
  ]
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

  return workLogs.filter(isVisibleWorkLog).flatMap((log) => {
    const task = taskById.get(log.taskId);
    if (!task) return [];

    const date = new Date(log.logDate);
    if (Number.isNaN(date.getTime())) return [];

    const project = projectById.get(task.projectId);

    return [
      {
        accountId: getAccountIdFromTask(task),
        periodLabel: format(date, "yyyy-MMM"),
        periodMonth: format(date, "MMM"),
        periodYear: format(date, "yyyy"),
        periodValue: format(date, "yyyy-MM"),
        projectName: project?.name ?? "",
        taskId: task.id,
        note: task.note ?? "",
        refUrl: task.refUrl ?? "",
        severity: task.severity ?? "NA",
        storyPoint: task.storyLevel?.toString() ?? "",
        timeSpentMinutes: log.timeSpentMinutes,
        type: task.type ?? "",
      },
    ];
  });
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

export function ExportDialog({ open, onOpenChange, projects, tasks, workLogs }: ExportDialogProps) {
  const exportRows = createExportRows(tasks, workLogs, projects);
  const exportPeriods = getExportPeriods(exportRows);
  const latestPeriod = exportPeriods[0] ?? null;
  const [selectedPeriodValue, setSelectedPeriodValue] = useState(latestPeriod?.value ?? "");
  const [exporting, setExporting] = useState(false);
  const [savedFileName, setSavedFileName] = useState("");
  const [savedPeriodValue, setSavedPeriodValue] = useState("");

  useEffect(() => {
    if (!open) return;

    setSelectedPeriodValue(getExportPeriods(exportRows)[0]?.value ?? "");
    setSavedFileName("");
    setSavedPeriodValue("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const matchingRows = exportRows.filter((row) => row.periodValue === selectedPeriodValue);
  const totalMinutes = matchingRows.reduce((sum, row) => sum + row.timeSpentMinutes, 0);
  const uniqueTaskIds = new Set(matchingRows.map((r) => r.taskId));
  const totalMandayMinutes = Array.from(uniqueTaskIds).reduce((sum, id) => {
    const task = taskById.get(id);
    return sum + (task?.mandays ?? 0) * 480;
  }, 0);
  const selectedPeriodLabel =
    exportPeriods.find((period) => period.value === selectedPeriodValue)?.label ?? "";
  const hasSavedCurrentPeriod = Boolean(savedFileName) && savedPeriodValue === selectedPeriodValue;

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
      setSavedPeriodValue(selectedPeriodValue);
      toast({
        title: "Export complete",
        description: `${matchingRows.length} worklog(s) saved to ${fileName}`,
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
                <p className="mt-1 text-xs text-muted-foreground">
                  Total logged time: {formatMinutesLong(totalMinutes)}
                </p>
                {totalMandayMinutes > 0 && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Total manday: {formatMinutesLong(totalMandayMinutes)}
                  </p>
                )}
              </>
            )}
            {matchingRows.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Select another month from Time Tracking to export.
              </p>
            )}
            {hasSavedCurrentPeriod && (
              <p className="mt-2 text-xs font-medium text-green-700 dark:text-green-400">
                Saved to {savedFileName}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleExport()}
            disabled={exporting || matchingRows.length === 0}
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
