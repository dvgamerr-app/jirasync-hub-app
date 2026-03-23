import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TaskTable } from "@/components/TaskTable";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { CommandMenu } from "@/components/CommandMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileSidebar } from "@/components/MobileSidebar";
import { ExportDialog } from "@/components/ExportDialog";
import { JiraSettingsDialog } from "@/components/JiraSettings";
import { type TaskStatusFilter, useTaskStore } from "@/store/task-store";
import {
  Search,
  CloudUpload,
  RefreshCw,
  Download,
  CheckCircle2,
  Server,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/hooks/use-toast";
import { onSyncStatus, startBackgroundSync, stopBackgroundSync, syncNow } from "@/lib/sync-service";
import { getJiraAccounts } from "@/lib/jira-db";
import { cn } from "@/lib/utils";

const TASK_STATUS_FILTERS: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

function EmptyTasksState({
  hasJiraAccounts,
  hasAnyTasks,
  syncing,
  taskStatusFilter,
  onOpenSettings,
  onSync,
}: {
  hasJiraAccounts: boolean;
  hasAnyTasks: boolean;
  syncing: boolean;
  taskStatusFilter: TaskStatusFilter;
  onOpenSettings: () => void;
  onSync: () => Promise<void>;
}) {
  const title = hasAnyTasks ? "No matching tasks" : "No tasks yet";
  const message = hasAnyTasks
    ? taskStatusFilter === "done"
      ? "No done tasks match the current project selection."
      : taskStatusFilter === "active"
        ? "No active tasks match the current project selection."
        : "No tasks match the current project selection."
    : hasJiraAccounts
      ? "This workspace is still empty. Run Sync to pull tasks from your connected Jira instance."
      : "Add a Jira instance in Jira Settings to start your first sync and load tasks into this workspace.";

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-dashed border-border bg-card/70 p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <Server className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>

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
    tasks: allTasks,
    selectedTaskId,
    selectedProjectId,
    getFilteredTasks,
    projects,
    workLogs,
    syncAllDirtyTasks,
    getDirtyTaskCount,
    taskStatusFilter,
    loadFromDB,
    reloadFromDB,
    setTaskStatusFilter,
    isLoaded,
  } = useTaskStore();
  const filteredTasks = getFilteredTasks();
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const isMobile = useIsMobile();
  const dirtyCount = getDirtyTaskCount();
  const [syncing, setSyncing] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushDone, setPushDone] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hasJiraAccounts = getJiraAccounts().length > 0;
  const showEmptyState = isLoaded && filteredTasks.length === 0 && !selectedTaskId;

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
        void reloadFromDB();
      } else if (status === "error") {
        toast({ title: "Sync Failed", description: message, variant: "destructive" });
      }
    });

    if (getJiraAccounts().length > 0) {
      startBackgroundSync();
    }

    return () => {
      unsub();
      stopBackgroundSync();
    };
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
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[13px] font-semibold">
              {currentProject ? currentProject.name : "All Tasks"}
            </h1>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {filteredTasks.length}
            </span>
            <div className="flex items-center rounded-md border border-border bg-muted/30 p-0.5">
              {TASK_STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setTaskStatusFilter(filter.value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors sm:text-[12px]",
                    taskStatusFilter === filter.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
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
              className="h-7 gap-1.5 text-[12px] transition-all duration-300"
              disabled={allTasks.length === 0}
              onClick={() => {
                setExportDialogOpen(true);
              }}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export</span>
            </Button>
            <ThemeToggle />
            <MobileSidebar onOpenSettings={() => setSettingsOpen(true)} />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {showEmptyState ? (
            <EmptyTasksState
              hasJiraAccounts={hasJiraAccounts}
              hasAnyTasks={allTasks.length > 0}
              syncing={syncing}
              taskStatusFilter={taskStatusFilter}
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
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        tasks={allTasks}
        workLogs={workLogs}
        projects={projects}
      />
      <JiraSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
};

export default Index;
