import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TaskTable } from "@/components/TaskTable";
import { CreatedTicketTable } from "@/components/CreatedTicketTable";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { CommandMenu } from "@/components/CommandMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileSidebar } from "@/components/MobileSidebar";
import { ExportDialog } from "@/components/ExportDialog";
import { JiraSettingsDialog } from "@/components/JiraSettings";
import {
  filterTasks,
  type TaskScopeFilter,
  type TaskStatusFilter,
  useTaskStore,
} from "@/store/task-store";
import { useShallow } from "zustand/react/shallow";
import {
  Search,
  X,
  CloudUpload,
  RefreshCw,
  Download,
  CheckCircle2,
  Server,
  Settings,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/hooks/use-toast";
import {
  onSyncResult,
  onSyncStatus,
  startBackgroundSync,
  stopBackgroundSync,
  syncNow,
} from "@/lib/sync-service";
import { getJiraAccounts } from "@/lib/jira-db";
import { cn, getErrorMessage } from "@/lib/utils";

const TASK_STATUS_FILTERS: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

const PUSH_DONE_RESET_MS = 1800;

function getEmptyMessage(
  hasAnyTasks: boolean,
  taskStatusFilter: TaskStatusFilter,
  taskScopeFilter: TaskScopeFilter,
  hasJiraAccounts: boolean,
  searchQuery?: string,
): string {
  if (searchQuery?.trim()) return `ไม่พบ ticket ที่ตรงกับ "${searchQuery.trim()}"`;
  if (!hasAnyTasks) {
    if (!hasJiraAccounts)
      return "Add a Jira instance in Jira Settings to start your first sync and load tasks into this workspace.";
    return "This workspace is still empty. Run Sync to pull tasks from your connected Jira instance.";
  }
  if (taskScopeFilter === "created-by-me") {
    if (taskStatusFilter === "done") return "No created tickets are done yet.";
    if (taskStatusFilter === "active") return "No active tickets created by this account.";
    return "No tickets created by this account.";
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
  taskScopeFilter,
  searchQuery,
  onOpenSettings,
  onSync,
}: {
  hasJiraAccounts: boolean;
  hasAnyTasks: boolean;
  syncing: boolean;
  taskStatusFilter: TaskStatusFilter;
  taskScopeFilter: TaskScopeFilter;
  searchQuery: string;
  onOpenSettings: () => void;
  onSync: () => Promise<void>;
}) {
  const isSearching = searchQuery.trim().length > 0;
  const title = isSearching ? "ไม่พบผลลัพธ์" : hasAnyTasks ? "No matching tasks" : "No tasks yet";
  const message = getEmptyMessage(
    hasAnyTasks,
    taskStatusFilter,
    taskScopeFilter,
    hasJiraAccounts,
    searchQuery,
  );

  return (
    <section className="border-border bg-card/70 m-auto w-[calc(100%-3rem)] max-w-md rounded-2xl border border-dashed p-8 text-center shadow-sm">
      <div className="bg-muted mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
        <Server className="text-muted-foreground h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground mt-2 text-sm leading-6">{message}</p>

      {!isSearching && (
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {hasJiraAccounts ? (
            <>
              <Button className="h-9 text-[13px]" onClick={() => void onSync()} disabled={syncing}>
                <RefreshCw className={syncing ? "animate-spin" : ""} />
                {syncing ? "Syncing..." : "Sync Now"}
              </Button>
              <Button variant="outline" className="h-9 text-[13px]" onClick={onOpenSettings}>
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            </>
          ) : (
            <Button className="h-9 text-[13px]" onClick={onOpenSettings}>
              <Settings className="h-4 w-4" />
              Add Jira Instance
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

const Index = () => {
  const {
    tasks: allTasks,
    selectedTaskId,
    selectedProjectId,
    projects,
    workLogs,
    syncAllDirtyTasks,
    discardAllDirtyTasks,
    getDirtyTaskCount,
    taskStatusFilter,
    taskScopeFilter,
    loadFromDB,
    reloadFromDB,
    applySyncResult,
    waitingForSync,
    setTaskStatusFilter,
    searchQuery,
    setSearchQuery,
    hiddenProjectIds,
    isLoaded,
  } = useTaskStore(
    useShallow((s) => ({
      tasks: s.tasks,
      selectedTaskId: s.selectedTaskId,
      selectedProjectId: s.selectedProjectId,
      projects: s.projects,
      workLogs: s.workLogs,
      syncAllDirtyTasks: s.syncAllDirtyTasks,
      discardAllDirtyTasks: s.discardAllDirtyTasks,
      getDirtyTaskCount: s.getDirtyTaskCount,
      taskStatusFilter: s.taskStatusFilter,
      taskScopeFilter: s.taskScopeFilter,
      loadFromDB: s.loadFromDB,
      reloadFromDB: s.reloadFromDB,
      applySyncResult: s.applySyncResult,
      waitingForSync: s.waitingForSync,
      setTaskStatusFilter: s.setTaskStatusFilter,
      searchQuery: s.searchQuery,
      setSearchQuery: s.setSearchQuery,
      hiddenProjectIds: s.hiddenProjectIds,
      isLoaded: s.isLoaded,
    })),
  );
  const filteredTasks = useMemo(
    () =>
      filterTasks(
        allTasks,
        selectedProjectId,
        taskStatusFilter,
        searchQuery,
        hiddenProjectIds,
        taskScopeFilter,
      ),
    [allTasks, hiddenProjectIds, searchQuery, selectedProjectId, taskScopeFilter, taskStatusFilter],
  );
  // Export every ticket I logged time on — including ones I created that are now assigned to
  // someone else (the "Created by me" view). Rows only exist for tasks with my own worklogs.
  const exportTasks = allTasks;
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const isMobile = useIsMobile();
  const dirtyCount = getDirtyTaskCount();
  const [syncing, setSyncing] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushDone, setPushDone] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchInputValue, setSearchInputValue] = useState(searchQuery);
  const [, startTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInputValue), 250);
    return () => clearTimeout(timer);
  }, [searchInputValue, setSearchQuery]);
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
        setSearchInputValue("");
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

      if (status === "error") {
        toast({ title: "Sync Failed", description: message, variant: "destructive" });
      }
    });

    // The pull hands over exactly what it wrote, so the store never has to re-read IndexedDB.
    const unsubResult = onSyncResult(applySyncResult);

    if (getJiraAccounts().length > 0) {
      startBackgroundSync();
    }

    return () => {
      unsub();
      unsubResult();
      stopBackgroundSync();
    };
  }, [isLoaded, applySyncResult]);

  const handleManualSync = async () => {
    try {
      // A manual sync is authoritative: re-read everything (the hourly one is incremental).
      await syncNow({ full: true });
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
    } catch (err: unknown) {
      setPushing(false);
      toast({
        title: "Sync failed",
        description: getErrorMessage(err),
        variant: "destructive",
      });
    }
  };

  const handleDiscardAllDirtyTasks = async () => {
    if (discarding) return;
    setDiscarding(true);
    try {
      await discardAllDirtyTasks();
      toast({
        title: "Changes discarded",
        description: "Unsynced local changes were reverted to Jira",
      });
    } catch (err: unknown) {
      toast({
        title: "Discard failed",
        description: getErrorMessage(err),
        variant: "destructive",
      });
    } finally {
      setDiscarding(false);
      setDiscardConfirmOpen(false);
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
      <AppSidebar onOpenSettings={() => setSettingsOpen(true)} />

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="border-border flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[13px] font-semibold">
              {currentProject
                ? currentProject.name
                : taskScopeFilter === "created-by-me"
                  ? "Created by me"
                  : "My Work"}
            </h1>
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] tabular-nums">
              {filteredTasks.length}
            </span>
            {dirtyCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-6 gap-1 px-1.5 text-[11px]"
                disabled={discarding}
                onClick={() => setDiscardConfirmOpen(true)}
              >
                <Undo2 className="h-3 w-3" />
                Discard all
              </Button>
            )}
            <div className="border-border bg-muted/30 flex items-center rounded-md border p-0.5">
              {TASK_STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => startTransition(() => setTaskStatusFilter(filter.value))}
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
                value={searchInputValue}
                onChange={(e) => setSearchInputValue(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                placeholder="Search… (Ctrl+F)"
                className={cn(
                  "border-border text-muted-foreground placeholder:text-muted-foreground/60 h-8 w-40 rounded-md pl-6 text-[11px] shadow-none transition-[width] duration-200 focus-visible:ring-1",
                  searchInputValue ? "pr-6" : "pr-2",
                  searchFocused && "w-52",
                )}
              />
              {searchInputValue && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground absolute right-1.5"
                  onClick={() => {
                    setSearchInputValue("");
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

            {waitingForSync > 0 && (
              <span role="status" className="text-muted-foreground text-[11px] whitespace-nowrap">
                Waiting for sync…
              </span>
            )}
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
                aria-label={pushDone ? "Pushed to Jira" : `Push ${dirtyCount} change(s) to Jira`}
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
              disabled={exportTasks.length === 0}
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
              taskScopeFilter={taskScopeFilter}
              searchQuery={searchQuery}
              onOpenSettings={() => setSettingsOpen(true)}
              onSync={handleManualSync}
            />
          ) : isMobile ? (
            selectedTaskId && taskScopeFilter === "my-work" ? (
              <TaskDetailPanel />
            ) : taskScopeFilter === "created-by-me" ? (
              <CreatedTicketTable tasks={filteredTasks} />
            ) : (
              <TaskTable tasks={filteredTasks} />
            )
          ) : (
            <>
              {taskScopeFilter === "created-by-me" ? (
                <CreatedTicketTable tasks={filteredTasks} />
              ) : (
                <TaskTable tasks={filteredTasks} />
              )}
              {taskScopeFilter === "my-work" && selectedTaskId && <TaskDetailPanel />}
            </>
          )}
        </div>
      </main>

      <CommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        tasks={exportTasks}
        workLogs={workLogs}
        projects={projects}
      />
      <JiraSettingsDialog open={settingsOpen} onOpenChange={handleSettingsOpenChange} />
      <AlertDialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard all local changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {dirtyCount} unsynced task(s) will be reverted to their latest state in Jira. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discarding}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={discarding}
              onClick={(e) => {
                e.preventDefault();
                void handleDiscardAllDirtyTasks();
              }}
            >
              {discarding ? "Discarding..." : "Discard all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Index;
