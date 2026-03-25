import { useTaskStore } from "@/store/task-store";
import { ChevronDown, FolderKanban, ListTodo, Menu, Settings } from "lucide-react";
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
  const { organizations, selectedProjectId, setSelectedProject, getVisibleProjects } =
    useTaskStore();
  const projects = getVisibleProjects();

  const handleSelect = (id: string | null) => {
    setSelectedProject(id);
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
        <SheetTitle className="border-b border-border px-3 py-3 text-[13px] font-semibold">
          Task Manager
        </SheetTitle>
        <div className="flex-1 overflow-y-auto p-2">
          <button
            onClick={() => handleSelect(null)}
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
                      onClick={() => handleSelect(project.id)}
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
        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            className="h-9 w-full justify-start gap-2 text-[13px] text-muted-foreground"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Settings className="h-3.5 w-3.5" />
            Jira Settings
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
