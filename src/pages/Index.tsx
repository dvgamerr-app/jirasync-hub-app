import { useEffect, useRef, useState } from "react";
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
  X,
  CloudUpload,
  RefreshCw,
  Download,
  CheckCircle2,
  Server,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

const PUSH_DONE_RESET_MS = 1800;

function getEmptyMessage(
  hasAnyTasks: boolean,
  taskStatusFilter: TaskStatusFilter,
  hasJiraAccounts: boolean,
): string {
  if (!hasAnyTasks) {
    if (!hasJiraAccounts)
      return "Add a Jira instance in Jira Settings to start your first sync and load tasks into this workspace.";
    return "This workspace is still empty. Run Sync to pull tasks from your connected Jira instance.";
  }
  if (taskStatusFilter === "done") return "No done tasks match the current project selection.";
  if (taskStatusFilter === "active") return "No active tasks match the current project selection.";
  return "No tasks match the current project selection.";
}

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
  const message = getEmptyMessage(hasAnyTasks, taskStatusFilter, hasJiraAccounts);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="border-border bg-card/70 w-full max-w-md rounded-2xl border border-dashed p-8 text-center shadow-sm">
        <div className="bg-muted mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
          <Server className="text-muted-foreground h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-muted-foreground mt-2 text-sm leading-6">{message}</p>

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
    searchQuery,
    setSearchQuery,
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
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hasJiraAccounts = getJiraAccounts().length > 0;
  const showEmptyState = isLoaded && filteredTasks.length === 0 && !selectedTaskId;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (e.key === "Escape" && searchFocused) {
        setSearchQuery("");
        searchInputRef.current?.blur();
      }
    };
    // capture: true fires before WebView2 processes browser accelerator keys (Ctrl+F find bar)
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [searchFocused, setSearchQuery]);

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
      // error is reported via the onSyncStatus listener; no additional handling needed here
    }
  };

  const handlePushDirtyTasks = async () => {
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
      setTimeout(() => setPushDone(false), PUSH_DONE_RESET_MS);
    } catch {
      setPushing(false);
      toast({
        title: "Sync failed",
        description: "Some tasks could not be synced",
        variant: "destructive",
      });
    }
  };

  const handleSettingsOpenChange = (open: boolean) => {
    setSettingsOpen(open);

    if (!open && settingsOpen) {
      void reloadFromDB();
    }
  };

  return (
    <div className="bg-background flex h-full w-full overflow-hidden">
      <div className="hidden md:block">
        <AppSidebar onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="border-border flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[13px] font-semibold">
              {currentProject ? currentProject.name : "All Tasks"}
            </h1>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] tabular-nums">
              {filteredTasks.length}
            </span>
            <div className="border-border bg-muted/30 flex items-center rounded-md border p-0.5">
              {TASK_STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setTaskStatusFilter(filter.value)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] font-medium sm:text-[12px]",
                    taskStatusFilter === filter.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="relative hidden items-center md:flex">
              <Search className="text-muted-foreground pointer-events-none absolute left-2 h-3 w-3" />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search… (Ctrl+F)"
                className={cn(
                  "border-border text-muted-foreground placeholder:text-muted-foreground/60 h-8 w-40 rounded-md pl-6 text-[12px] shadow-none transition-[width] duration-200 focus-visible:ring-1",
                  searchQuery ? "pr-6" : "pr-2",
                  searchFocused && "w-52",
                )}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground absolute right-1.5"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground h-7 gap-1.5 text-[12px] md:hidden"
              onClick={() => setCommandMenuOpen(true)}
            >
              <Search className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            {/* Manual sync button */}
            <Button
              variant="outline"
              size="sm"
              className={`h-7 gap-1.5 text-[12px] ${syncing ? "border-primary ring-primary/30 animate-pulse ring-2" : ""}`}
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
                className={`h-7 gap-1.5 text-[12px] ${
                  pushDone
                    ? "border-green-500 text-green-600 dark:text-green-400"
                    : pushing
                      ? "border-primary ring-primary/30 ring-2"
                      : ""
                }`}
                disabled={pushing || pushDone}
                onClick={() => void handlePushDirtyTasks()}
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
              className="h-7 gap-1.5 text-[12px]"
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

      <CommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        tasks={allTasks}
        workLogs={workLogs}
        projects={projects}
      />
      <JiraSettingsDialog open={settingsOpen} onOpenChange={handleSettingsOpenChange} />
    </div>
  );
};

export default Index;
