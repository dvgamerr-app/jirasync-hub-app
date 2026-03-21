import { AppSidebar } from "@/components/AppSidebar";
import { TaskTable } from "@/components/TaskTable";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { CommandMenu } from "@/components/CommandMenu";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MobileSidebar } from "@/components/MobileSidebar";
import { useTaskStore } from "@/store/task-store";
import { Search, CloudUpload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { toast } from "@/hooks/use-toast";

const Index = () => {
  const { selectedTaskId, selectedProjectId, getFilteredTasks, projects, syncAllDirtyTasks, getDirtyTaskCount } = useTaskStore();
  const tasks = getFilteredTasks();
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const isMobile = useIsMobile();
  const dirtyCount = getDirtyTaskCount();

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Desktop sidebar */}
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
            {/* Search button - mobile only */}
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
            {dirtyCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                onClick={() => {
                  syncAllDirtyTasks();
                  toast({ title: "Synced to Jira", description: `${dirtyCount} task(s) synced successfully` });
                }}
              >
                <CloudUpload className="h-3.5 w-3.5" />
                <span>Sync</span>
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
