import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TaskTable } from "@/components/TaskTable";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { CommandMenu } from "@/components/CommandMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileSidebar } from "@/components/MobileSidebar";
import { useTaskStore } from "@/store/task-store";
import { Search, CloudUpload, RefreshCw, Download, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/hooks/use-toast";
import { startBackgroundSync, syncNow, onSyncStatus } from "@/lib/sync-service";
import { getJiraAccounts } from "@/lib/jira-db";
import type { Task, WorkLog, Project } from "@/types/jira";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function exportToCSV(tasks: Task[], workLogs: WorkLog[], projects: Project[]) {
  const header = ["FullName","Project","Month","Year","Type","Story Point","Serverity","Usage Time (min)","Ref URL","Note"];
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

const Index = () => {
  const { selectedTaskId, selectedProjectId, getFilteredTasks, projects, workLogs, syncAllDirtyTasks, getDirtyTaskCount, loadFromDB, reloadFromDB, isLoaded } = useTaskStore();
  const tasks = getFilteredTasks();
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const isMobile = useIsMobile();
  const dirtyCount = getDirtyTaskCount();
  const [syncing, setSyncing] = useState(false);
  const [exportDone, setExportDone] = useState(false);

  // Load data from IndexedDB on mount
  useEffect(() => {
    loadFromDB();
  }, []);

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
        toast({ title: "Jira Synced", description: message });
      } else if (status === "error") {
        toast({ title: "Sync Failed", description: message, variant: "destructive" });
      }
    });

    if (getJiraAccounts().length > 0) {
      startBackgroundSync();
    }

    return unsub;
  }, [isLoaded]);

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
        <AppSidebar />
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
              className={`h-7 gap-1.5 text-[12px] transition-all duration-300 ${syncing ? "border-primary ring-2 ring-primary/30 animate-pulse" : ""}`}
              onClick={handleManualSync}
              disabled={syncing}
            >
              <RefreshCw className={`h-3.5 w-3.5 transition-transform ${syncing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Sync</span>
            </Button>

            {dirtyCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                onClick={async () => {
                  try {
                    await syncAllDirtyTasks();
                    toast({ title: "Synced to Jira", description: `${dirtyCount} task(s) pushed to Jira` });
                  } catch {
                    toast({ title: "Sync failed", description: "Some tasks could not be synced", variant: "destructive" });
                  }
                }}
              >
                <CloudUpload className="h-3.5 w-3.5" />
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warning text-[10px] font-semibold text-warning-foreground px-1">
                  {dirtyCount}
                </span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className={`h-7 gap-1.5 text-[12px] transition-all duration-300 ${exportDone ? "border-green-500 text-green-600 dark:text-green-400" : ""}`}
              onClick={() => {
                exportToCSV(tasks, workLogs, projects);
                setExportDone(true);
                setTimeout(() => setExportDone(false), 1500);
              }}
            >
              {exportDone
                ? <Check className="h-3.5 w-3.5" />
                : <Download className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{exportDone ? "Done" : "Export"}</span>
            </Button>
            <ThemeToggle />
            <MobileSidebar />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {isMobile ? (
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
    </div>
  );
};

export default Index;
