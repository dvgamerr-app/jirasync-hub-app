import { useState, useEffect, useTransition } from "react";
import { useTaskStore } from "@/store/task-store";
import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  Eye,
  EyeOff,
  FolderKanban,
  ListTodo,
  Settings,
  RefreshCw,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getLastSyncTime, onSyncStatus } from "@/lib/sync-service";
import { formatDistanceToNow } from "date-fns";

interface AppSidebarProps {
  onOpenSettings: () => void;
}

export function AppSidebar({ onOpenSettings }: AppSidebarProps) {
  const {
    organizations,
    selectedProjectId,
    setSelectedProject,
    getVisibleProjects,
    hiddenProjectIds,
    toggleProjectVisibility,
  } = useTaskStore(
    useShallow((s) => ({
      organizations: s.organizations,
      selectedProjectId: s.selectedProjectId,
      setSelectedProject: s.setSelectedProject,
      getVisibleProjects: s.getVisibleProjects,
      hiddenProjectIds: s.hiddenProjectIds,
      toggleProjectVisibility: s.toggleProjectVisibility,
    })),
  );
  const projects = getVisibleProjects();
  const [, startTransition] = useTransition();
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    getLastSyncTime().then(setLastSync);
    return onSyncStatus((status) => {
      if (status === "success") {
        getLastSyncTime().then(setLastSync);
      }
    });
  }, []);

  return (
    <>
      <aside className="border-border bg-card flex h-full w-[280px] flex-col border-r">
        {/* Header */}
        <div className="border-border border-b p-3">
          <h2 className="text-[13px] font-semibold">Task Manager</h2>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto p-2">
          <button
            onClick={() => startTransition(() => setSelectedProject(null))}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
              !selectedProjectId
                ? "bg-primary/10 text-primary font-medium"
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
                <CollapsibleTrigger className="text-muted-foreground flex w-full items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold tracking-wider uppercase">
                  <ChevronDown className="h-3 w-3" />
                  {org.name}
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-1 space-y-0.5">
                  {orgProjects.map((project) => {
                    const isHidden = hiddenProjectIds.has(project.id);
                    return (
                      <button
                        key={project.id}
                        onClick={() => startTransition(() => setSelectedProject(project.id))}
                        className={cn(
                          "group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
                          selectedProjectId === project.id
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                          isHidden && "opacity-50",
                        )}
                      >
                        <span
                          className="shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            startTransition(() => toggleProjectVisibility(project.id));
                          }}
                        >
                          {isHidden ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <>
                              <FolderKanban className="h-3.5 w-3.5 group-hover:hidden" />
                              <Eye className="hidden h-3.5 w-3.5 group-hover:inline-block" />
                            </>
                          )}
                        </span>
                        <span className="truncate">{project.name}</span>
                        <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                          {project.jiraProjectKey}
                        </span>
                      </button>
                    );
                  })}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-border space-y-1 border-t px-3 py-2">
          {lastSync && (
            <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <RefreshCw className="h-3 w-3" />
              <span>Synced {formatDistanceToNow(new Date(lastSync), { addSuffix: true })}</span>
            </div>
          )}
          <button
            onClick={onOpenSettings}
            className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]"
          >
            <Settings className="h-3.5 w-3.5" />
            Jira Settings
          </button>
        </div>
      </aside>
    </>
  );
}
