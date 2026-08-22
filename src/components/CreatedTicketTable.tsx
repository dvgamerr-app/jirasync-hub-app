import { formatDistanceToNow } from "date-fns";
import { ExternalLink } from "lucide-react";
import type { Task } from "@/types/jira";
import { StatusBadge } from "@/components/StatusBadge";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? "—" : formatDistanceToNow(date, { addSuffix: true });
}

export function CreatedTicketTable({ tasks }: { tasks: Task[] }) {
  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader className="bg-background sticky top-0 z-10">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[120px] text-[11px] font-semibold tracking-wider uppercase">
              ID
            </TableHead>
            <TableHead className="text-[11px] font-semibold tracking-wider uppercase">
              Title
            </TableHead>
            <TableHead className="w-[180px] text-[11px] font-semibold tracking-wider uppercase">
              Assignee
            </TableHead>
            <TableHead className="w-[160px] text-[11px] font-semibold tracking-wider uppercase">
              Status
            </TableHead>
            <TableHead className="w-[140px] text-[11px] font-semibold tracking-wider uppercase">
              Updated
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow
              key={task.id}
              className={cn("h-10", task.statusCategory === "done" && "opacity-65")}
            >
              <TableCell className="py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground font-mono text-[12px] tabular-nums">
                    {task.jiraTaskId}
                  </span>
                  {task.refUrl && (
                    <button
                      type="button"
                      aria-label={`Open ${task.jiraTaskId} in Jira`}
                      onClick={() => void openExternal(task.refUrl!)}
                    >
                      <ExternalLink className="text-muted-foreground hover:text-primary h-3 w-3" />
                    </button>
                  )}
                </div>
              </TableCell>
              <TableCell className="py-1.5">
                <span className="line-clamp-1 text-[13px] leading-tight font-medium">
                  {task.title}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground py-1.5 text-[12px]">
                {task.assignee ?? "Unassigned"}
              </TableCell>
              <TableCell className="py-1.5">
                <StatusBadge status={task.status} truncate />
              </TableCell>
              <TableCell className="text-muted-foreground py-1.5 text-[12px] whitespace-nowrap">
                {formatUpdatedAt(task.updatedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
