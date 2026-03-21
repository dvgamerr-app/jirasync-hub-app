import { cn } from "@/lib/utils";

const statusColorMap: Record<string, string> = {
  "To Do": "bg-muted text-muted-foreground",
  Backlog: "bg-muted text-muted-foreground",
  Open: "bg-muted text-muted-foreground",
  "In Progress": "bg-primary/15 text-primary",
  "In Review": "bg-warning/15 text-warning",
  Review: "bg-warning/15 text-warning",
  QA: "bg-info/15 text-info",
  Testing: "bg-info/15 text-info",
  Done: "bg-success/15 text-success",
  Closed: "bg-success/15 text-success",
};

export function StatusBadge({ status, className }: { status: string | null; className?: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;

  const colorClass = statusColorMap[status] ?? "bg-muted text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight",
        colorClass,
        className,
      )}
    >
      {status}
    </span>
  );
}
