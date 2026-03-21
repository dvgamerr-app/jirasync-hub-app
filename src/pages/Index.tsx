import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TaskTable } from "@/components/TaskTable";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { CommandMenu } from "@/components/CommandMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileSidebar } from "@/components/MobileSidebar";
import { JiraSettingsDialog } from "@/components/JiraSettings";
import { useTaskStore } from "@/store/task-store";
import {
  Search,
  CloudUpload,
  RefreshCw,
  Download,
  Check,
  CheckCircle2,
  Server,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/hooks/use-toast";
import { startBackgroundSync, syncNow, onSyncStatus } from "@/lib/sync-service";
import { getJiraAccounts } from "@/lib/jira-db";
import type { Task, WorkLog, Project } from "@/types/jira";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function exportToCSV(tasks: Task[], workLogs: WorkLog[], projects: Project[]) {
  const header = [
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
  const rowsData = workLogs
    .map((log) => {
      const task = tasks.find((t) => t.id === log.taskId);
      if (!task) return null;
      const project = projects.find((p) => p.id === task.projectId);
      const date = new Date(log.logDate);
      return [
        task.assignee ?? "",
        project?.name ?? "",
        MONTHS[date.getMonth()],
        date.getFullYear().toString(),
        task.type ?? "",
        task.storyLevel?.toString() ?? "",
        task.severity ?? "NA",
        log.timeSpentMinutes.toString(),
        task.refUrl ?? "",
        task.note ?? "",
      ];
    })
    .filter((r): r is string[] => r !== null);

  const escape = (v: string) =>
    v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;

  const csv = [header, ...rowsData].map((row) => row.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jirasync-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function EmptyTasksState({
  hasJiraAccounts,
  syncing,
  onOpenSettings,
  onSync,
}: {
  hasJiraAccounts: boolean;
  syncing: boolean;
  onOpenSettings: () => void;
  onSync: () => Promise<void>;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-dashed border-border bg-card/70 p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <Server className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold">No tasks yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {hasJiraAccounts
            ? "This workspace is still empty. Run Sync to pull tasks from your connected Jira instance."
            : "Add a Jira instance in Jira Settings to start your first sync and load tasks into this workspace."}
        </p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {hasJiraAccounts ? (
            <>
              <Button className="h-9 text-[13px]" onClick={() => void onSync()} disabled={syncing}>
                <RefreshCw className={syncing ? "animate-spin" : ""} />
                {syncing ? "Syncing..." : "Sync Now"}
              </Button>
              <Button variant="outline" className="h-9 text-[13px]" onClick={onOpenSettings}>
                <Settings className="h-4 w-4" />
                Jira Settings
              </Button>
            </>
          ) : (
            <Button className="h-9 text-[13px]" onClick={onOpenSettings}>
              <Settings className="h-4 w-4" />
              Add Jira Instance
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const Index = () => {
  const {
    selectedTaskId,
    selectedProjectId,
    getFilteredTasks,
    projects,
    workLogs,
    syncAllDirtyTasks,
    getDirtyTaskCount,
    loadFromDB,
    reloadFromDB,
    isLoaded,
  } = useTaskStore();
  const tasks = getFilteredTasks();
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const isMobile = useIsMobile();
  const dirtyCount = getDirtyTaskCount();
  const [syncing, setSyncing] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushDone, setPushDone] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hasJiraAccounts = getJiraAccounts().length > 0;
  const showEmptyState = isLoaded && tasks.length === 0 && !selectedTaskId;

  // Load data from IndexedDB on mount
  useEffect(() => {
    loadFromDB();
  }, [loadFromDB]);

  // Start background sync if Jira configured
  useEffect(() => {
    if (!isLoaded) return;

    // Register listener BEFORE startBackgroundSync so we don't miss the
    // synchronous notify("syncing") that fires inside syncNow() before its
    // first await.
    const unsub = onSyncStatus((status, message) => {
      if (status === "syncing") setSyncing(true);
      else setSyncing(false);

      if (status === "success") {
        reloadFromDB();
      } else if (status === "error") {
        toast({ title: "Sync Failed", description: message, variant: "destructive" });
      }
    });

    if (getJiraAccounts().length > 0) {
      startBackgroundSync();
    }

    return unsub;
  }, [isLoaded, reloadFromDB]);

  const handleManualSync = async () => {
    try {
      await syncNow();
    } catch {
      // handled by listener
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <div className="hidden md:block">
        <AppSidebar onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-11 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <h1 className="text-[13px] font-semibold">
              {currentProject ? currentProject.name : "All Tasks"}
            </h1>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {tasks.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px] text-muted-foreground md:hidden"
              onClick={() => {
                document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
              }}
            >
              <Search className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            {/* Manual sync button */}
            <Button
              variant="outline"
              size="sm"
              className={`h-7 gap-1.5 text-[12px] transition-all duration-300 ${syncing ? "animate-pulse border-primary ring-2 ring-primary/30" : ""}`}
              onClick={handleManualSync}
              disabled={syncing || !hasJiraAccounts}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 transition-transform ${syncing ? "animate-spin" : ""}`}
              />
              <span className="hidden sm:inline">Sync</span>
            </Button>

            {(dirtyCount > 0 || pushDone) && (
              <Button
                variant="outline"
                size="sm"
                className={`h-7 gap-1.5 text-[12px] transition-all duration-300 ${
                  pushDone
                    ? "border-green-500 text-green-600 dark:text-green-400"
                    : pushing
                      ? "border-primary ring-2 ring-primary/30"
                      : ""
                }`}
                disabled={pushing || pushDone}
                onClick={async () => {
                  if (pushing || pushDone) return;
                  setPushing(true);
                  const count = dirtyCount;
                  try {
                    await syncAllDirtyTasks();
                    setPushing(false);
                    setPushDone(true);
                    toast({
                      title: "Synced to Jira",
                      description: `${count} task(s) pushed to Jira`,
                    });
                    setTimeout(() => setPushDone(false), 1800);
                  } catch {
                    setPushing(false);
                    toast({
                      title: "Sync failed",
                      description: "Some tasks could not be synced",
                      variant: "destructive",
                    });
                  }
                }}
              >
                {pushDone ? (
                  <CheckCircle2 className="animate-check-pop h-3.5 w-3.5 text-green-500" />
                ) : (
                  <CloudUpload className={`h-3.5 w-3.5 ${pushing ? "animate-cloud-upload" : ""}`} />
                )}
                {!pushDone && (
                  <span className="bg-warning text-warning-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold">
                    {dirtyCount}
                  </span>
                )}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className={`h-7 gap-1.5 text-[12px] transition-all duration-300 ${exportDone ? "border-green-500 text-green-600 dark:text-green-400" : ""}`}
              disabled={tasks.length === 0}
              onClick={() => {
                exportToCSV(tasks, workLogs, projects);
                setExportDone(true);
                setTimeout(() => setExportDone(false), 1500);
              }}
            >
              {exportDone ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">{exportDone ? "Done" : "Export"}</span>
            </Button>
            <ThemeToggle />
            <MobileSidebar onOpenSettings={() => setSettingsOpen(true)} />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {showEmptyState ? (
            <EmptyTasksState
              hasJiraAccounts={hasJiraAccounts}
              syncing={syncing}
              onOpenSettings={() => setSettingsOpen(true)}
              onSync={handleManualSync}
            />
          ) : isMobile ? (
            selectedTaskId ? (
              <TaskDetailPanel />
            ) : (
              <TaskTable />
            )
          ) : (
            <>
              <TaskTable />
              {selectedTaskId && <TaskDetailPanel />}
            </>
          )}
        </div>
      </div>

      <CommandMenu />
      <JiraSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
};

export default Index;
