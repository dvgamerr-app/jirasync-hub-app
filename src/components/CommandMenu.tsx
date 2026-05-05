import { useEffect, useState } from "react";
import { useTaskStore } from "@/store/task-store";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface CommandMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CommandMenu({ open: controlledOpen, onOpenChange: controlledOnOpenChange }: CommandMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;
  const { tasks, setSelectedTask, setSelectedProject, projects } = useTaskStore();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const handleSelectTask = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      setSelectedProject(task.projectId);
      setSelectedTask(taskId);
    }
    setOpen(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search tasks, projects..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Tasks">
          {tasks.map((task) => (
            <CommandItem
              key={task.id}
              value={`${task.jiraTaskId} ${task.title}`}
              onSelect={() => handleSelectTask(task.id)}
              className="text-[13px]"
            >
              <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                {task.jiraTaskId}
              </span>
              {task.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Projects">
          {projects.map((project) => (
            <CommandItem
              key={project.id}
              value={`${project.jiraProjectKey} ${project.name}`}
              onSelect={() => {
                setSelectedProject(project.id);
                setSelectedTask(null);
                setOpen(false);
              }}
              className="text-[13px]"
            >
              <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                {project.jiraProjectKey}
              </span>
              {project.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
