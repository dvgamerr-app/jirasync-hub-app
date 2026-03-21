import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TaskTable } from "@/components/TaskTable";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { CommandMenu } from "@/components/CommandMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileSidebar } from "@/components/MobileSidebar";
import { useTaskStore } from "@/store/task-store";
import { Search, CloudUpload, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/hooks/use-toast";
import { startBackgroundSync, syncNow, onSyncStatus } from "@/lib/sync-service";
import { getJiraAccounts } from "@/lib/jira-db";

const Index = () => {
  const { selectedTaskId, selectedProjectId, getFilteredTasks, projects, syncAllDirtyTasks, getDirtyTaskCount, loadFromDB, reloadFromDB, isLoaded } = useTaskStore();
  const tasks = getFilteredTasks();
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const isMobile = useIsMobile();
  const dirtyCount = getDirtyTaskCount();
  const [syncing, setSyncing] = useState(false);

  // Load data from IndexedDB on mount
  useEffect(() => {
    loadFromDB();
  }, []);

  // Start background sync if Jira configured
  useEffect(() => {
    if (!isLoaded) return;
    if (getJiraAccounts().length > 0) {
      startBackgroundSync();
    }

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
              className="h-7 gap-1.5 text-[12px]"
              onClick={handleManualSync}
              disabled={syncing}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
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
