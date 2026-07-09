import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTaskStore } from "@/store/task-store";

interface JiraLinkPickerProps {
  excludeIssueKeys: string[];
  onSelect: (task: { jiraTaskId: string; title: string }) => void;
}

/**
 * Autocomplete for linking a Jira ticket — reads tasks already loaded into
 * task-store (from IndexedDB via the existing sync), never fetches. Selection-only
 * (no free-text key entry) so a typo can't silently create a dead link.
 */
export function JiraLinkPicker({ excludeIssueKeys, onSelect }: JiraLinkPickerProps) {
  const [open, setOpen] = useState(false);
  const { tasks } = useTaskStore(useShallow((s) => ({ tasks: s.tasks })));

  const candidates = useMemo(() => {
    const excluded = new Set(excludeIssueKeys);
    return tasks.filter((task) => !task.isArchived && !excluded.has(task.jiraTaskId));
  }, [tasks, excludeIssueKeys]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]">
          <Plus className="h-3.5 w-3.5" />
          Link Jira ticket
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search synced Jira tickets…" />
          <CommandList>
            <CommandEmpty>
              {tasks.length === 0 ? "No Jira tickets synced yet." : "No matching tickets."}
            </CommandEmpty>
            <CommandGroup>
              {candidates.map((task) => (
                <CommandItem
                  key={task.id}
                  value={`${task.jiraTaskId} ${task.title}`}
                  onSelect={() => {
                    onSelect({ jiraTaskId: task.jiraTaskId, title: task.title });
                    setOpen(false);
                  }}
                  className="text-[13px]"
                >
                  <span className="text-muted-foreground mr-2 font-mono text-[11px]">
                    {task.jiraTaskId}
                  </span>
                  <span className="truncate">{task.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
