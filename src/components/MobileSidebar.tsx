import { useTaskStore } from "@/store/task-store";
import { ChevronDown, FolderKanban, ListTodo, Menu, Settings, UserRound } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useState } from "react";

interface MobileSidebarProps {
  onOpenSettings: () => void;
}

export function MobileSidebar({ onOpenSettings }: MobileSidebarProps) {
  const [open, setOpen] = useState(false);
  const {
    organizations,
    selectedProjectId,
    setSelectedProject,
    getVisibleProjects,
    taskScopeFilter,
    setTaskScopeFilter,
  } = useTaskStore();
  const projects = getVisibleProjects();

  const handleSelect = (id: string | null) => {
    setSelectedProject(id);
    setOpen(false);
  };

  const handleScopeSelect = (scope: "my-work" | "created-by-me") => {
    setTaskScopeFilter(scope);
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7 md:hidden">
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-[280px] flex-col p-0">
        <SheetTitle className="border-border border-b px-3 py-3 text-[13px] font-semibold">
          Task Manager
        </SheetTitle>
        <div className="flex-1 overflow-y-auto p-2">
          <button
            onClick={() => handleScopeSelect("my-work")}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
              taskScopeFilter === "my-work" && !selectedProjectId
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <ListTodo className="h-3.5 w-3.5" />
            My Work
          </button>
          <button
            onClick={() => handleScopeSelect("created-by-me")}
            className={cn(
              "mt-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
              taskScopeFilter === "created-by-me" && !selectedProjectId
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <UserRound className="h-3.5 w-3.5" />
            Created by me
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
                  {orgProjects.map((project) => (
                    <button
                      key={project.id}
                      onClick={() => handleSelect(project.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px]",
                        selectedProjectId === project.id
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <FolderKanban className="h-3.5 w-3.5" />
                      <span className="truncate">{project.name}</span>
                      <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                        {project.jiraProjectKey}
                      </span>
                    </button>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
        <div className="border-border border-t p-2">
          <Button
            variant="ghost"
            className="text-muted-foreground h-9 w-full justify-start gap-2 text-[13px]"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
