import { useEffect, useState } from "react";
import { Check, Download } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { fetchJiraMyselfDisplayName } from "@/lib/jira-api";
import { getJiraAccounts, type JiraAccount } from "@/lib/jira-db";
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

const MONTH_OPTIONS = [
  { value: "0", label: "January" },
  { value: "1", label: "February" },
  { value: "2", label: "March" },
  { value: "3", label: "April" },
  { value: "4", label: "May" },
  { value: "5", label: "June" },
  { value: "6", label: "July" },
  { value: "7", label: "August" },
  { value: "8", label: "September" },
  { value: "9", label: "October" },
  { value: "10", label: "November" },
  { value: "11", label: "December" },
] as const;

const CSV_HEADER = [
  "FullName",
  "Project",
  "Month",
  "Year",
  "Type",
  "Story Point",
  "Serverity",
  "Usage Time (min)",
  "Ref URL",
  "Note",
];

type ExportRow = {
  accountId: string | null;
  projectName: string;
  monthLabel: string;
  monthIndex: number;
  note: string;
  refUrl: string;
  severity: string;
  storyPoint: string;
  timeSpentMinutes: number;
  type: string;
  year: number;
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
      row.monthLabel,
      row.year.toString(),
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

function getAccountIdFromTask(task: Pick<Task, "id" | "jiraTaskId">): string | null {
  const prefix = "task-";
  const suffix = `-${task.jiraTaskId}`;

  if (!task.id.startsWith(prefix) || !task.id.endsWith(suffix)) {
    return null;
  }

  const accountId = task.id.slice(prefix.length, task.id.length - suffix.length);
  return accountId || null;
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

  return workLogs.flatMap((log) => {
    const task = taskById.get(log.taskId);
    if (!task) return [];

    const date = new Date(log.logDate);
    if (Number.isNaN(date.getTime())) return [];

    const project = projectById.get(task.projectId);

    return [
      {
        accountId: getAccountIdFromTask(task),
        projectName: project?.name ?? "",
        monthLabel: MONTH_OPTIONS[date.getMonth()].label,
        monthIndex: date.getMonth(),
        note: task.note ?? "",
        refUrl: task.refUrl ?? "",
        severity: task.severity ?? "NA",
        storyPoint: task.storyLevel?.toString() ?? "",
        year: date.getFullYear(),
        timeSpentMinutes: log.timeSpentMinutes,
        type: task.type ?? "",
      },
    ];
  });
}

function getCurrentPeriod() {
  const now = new Date();
  return {
    monthIndex: now.getMonth(),
    year: now.getFullYear(),
  };
}

function getExportFileName(monthIndex: number, year: number): string {
  return `jirasync-export-${year}-${String(monthIndex + 1).padStart(2, "0")}.csv`;
}

function getDisplayFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

export function ExportDialog({ open, onOpenChange, projects, tasks, workLogs }: ExportDialogProps) {
  const currentPeriod = getCurrentPeriod();
  const exportRows = createExportRows(tasks, workLogs, projects);
  const exportYears = Array.from(
    new Set([currentPeriod.year, ...exportRows.map((row) => row.year)]),
  ).sort((a, b) => b - a);
  const [selectedMonth, setSelectedMonth] = useState(currentPeriod.monthIndex.toString());
  const [selectedYear, setSelectedYear] = useState(currentPeriod.year.toString());
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [savedFileName, setSavedFileName] = useState("");

  useEffect(() => {
    if (!open) return;

    const period = getCurrentPeriod();
    setSelectedMonth(period.monthIndex.toString());
    setSelectedYear(period.year.toString());
    setExportDone(false);
    setSavedFileName("");
  }, [open]);

  const monthIndex = Number(selectedMonth);
  const year = Number(selectedYear);
  const matchingRows = exportRows.filter(
    (row) => row.monthIndex === monthIndex && row.year === year,
  );
  const totalMinutes = matchingRows.reduce((sum, row) => sum + row.timeSpentMinutes, 0);

  const handleExport = async () => {
    if (exporting || matchingRows.length === 0) return;

    setExporting(true);

    try {
      const filePath = await save({
        defaultPath: getExportFileName(monthIndex, year),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });

      if (!filePath) return;

      const fileName = getDisplayFileName(filePath);
      const fullNamesByAccountId = await getFullNamesByAccountId(matchingRows);
      await writeTextFile(filePath, buildCsv(matchingRows, fullNamesByAccountId));

      setSavedFileName(fileName);
      setExportDone(true);
      toast({
        title: "Export complete",
        description: `${matchingRows.length} worklog(s) saved to ${fileName}`,
      });
      setTimeout(() => onOpenChange(false), 1200);
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
            Choose the month and year to export, then pick where the CSV file should be saved.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="export-month">Month</Label>
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger id="export-month">
                <SelectValue placeholder="Select month" />
              </SelectTrigger>
              <SelectContent>
                {MONTH_OPTIONS.map((month) => (
                  <SelectItem key={month.value} value={month.value}>
                    {month.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="export-year">Year</Label>
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger id="export-year">
                <SelectValue placeholder="Select year" />
              </SelectTrigger>
              <SelectContent>
                {exportYears.map((optionYear) => (
                  <SelectItem key={optionYear} value={optionYear.toString()}>
                    {optionYear}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            className={`rounded-lg border px-3 py-3 ${
              exportDone ? "border-green-500/40 bg-green-500/10" : "bg-muted/40"
            }`}
          >
            <p className="text-sm font-medium">
              {exportDone
                ? `Saved to ${savedFileName}`
                : matchingRows.length > 0
                  ? `${matchingRows.length} worklog(s) ready to export`
                  : "No worklogs found for this period"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {exportDone
                ? "The dialog will close automatically."
                : matchingRows.length > 0
                  ? `Total logged time: ${totalMinutes} minute(s)`
                  : "Change the month or year if you need a different export range."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={exporting || exportDone}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleExport()}
            disabled={exporting || exportDone || matchingRows.length === 0}
            className={exportDone ? "border-green-500 text-green-600 dark:text-green-400" : ""}
          >
            {exportDone ? (
              <Check className="animate-check-pop h-4 w-4 text-green-500" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting ? "Saving..." : exportDone ? "Done" : "Save CSV"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
