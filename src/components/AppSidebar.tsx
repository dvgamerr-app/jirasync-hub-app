import { useState, useEffect } from "react";
import { useTaskStore } from "@/store/task-store";
import { ChevronDown, FolderKanban, ListTodo, Settings, RefreshCw } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getLastSyncTime } from "@/lib/sync-service";
import { formatDistanceToNow } from "date-fns";

interface AppSidebarProps {
  onOpenSettings: () => void;
}

export function AppSidebar({ onOpenSettings }: AppSidebarProps) {
  const { organizations, selectedProjectId, setSelectedProject, getVisibleProjects } = useTaskStore();
  const projects = getVisibleProjects();
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    getLastSyncTime().then(setLastSync);
    const interval = setInterval(() => getLastSyncTime().then(setLastSync), 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <aside className="flex h-full w-[280px] flex-col border-r border-border bg-card">
        {/* Header */}
        <div className="border-b border-border px-3 py-3">
          <h2 className="text-[13px] font-semibold">Task Manager</h2>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto p-2">
          <button
            onClick={() => setSelectedProject(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
              !selectedProjectId
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <ListTodo className="h-3.5 w-3.5" />
            All Tasks
          </button>

          {organizations.map((org) => {
            const orgProjects = projects.filter((p) => p.orgId === org.id);
            if (orgProjects.length === 0) return null;
            return (
              <Collapsible key={org.id} defaultOpen className="mt-3">
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <ChevronDown className="h-3 w-3" />
                  {org.name}
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-1 space-y-0.5">
                  {orgProjects.map((project) => (
                    <button
                      key={project.id}
                      onClick={() => setSelectedProject(project.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
                        selectedProjectId === project.id
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <FolderKanban className="h-3.5 w-3.5" />
                      <span className="truncate">{project.name}</span>
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {project.jiraProjectKey}
                      </span>
                    </button>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>

        {/* Footer */}
        <div className="space-y-1 border-t border-border px-3 py-2">
          {lastSync && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
              <span>Synced {formatDistanceToNow(new Date(lastSync), { addSuffix: true })}</span>
            </div>
          )}
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
            Jira Settings
          </button>
        </div>
      </aside>
    </>
  );
}
