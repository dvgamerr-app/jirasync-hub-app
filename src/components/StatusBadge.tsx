import { cn } from "@/lib/utils";

const statusColorMap: Record<string, string> = {
  "To Do": "bg-zinc-300 text-zinc-700 dark:bg-zinc-500 dark:text-zinc-100",
  Backlog: "bg-zinc-300 text-zinc-700 dark:bg-zinc-500 dark:text-zinc-100",
  Open: "bg-zinc-300 text-zinc-700 dark:bg-zinc-500 dark:text-zinc-100",
  "In Progress": "bg-primary/15 text-primary",
  "In Review": "bg-warning/15 text-warning",
  Review: "bg-warning/15 text-warning",
  QA: "bg-info/15 text-info",
  Testing: "bg-info/15 text-info",
  Done: "bg-success/15 text-success",
  Closed: "bg-success/15 text-success",
};

export function StatusBadge({
  status,
  className,
  truncate = false,
}: {
  status: string | null;
  className?: string;
  truncate?: boolean;
}) {
  if (!status) return <span className="text-muted-foreground">—</span>;

  const colorClass = statusColorMap[status] ?? "text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-tight font-medium",
        truncate && "max-w-[10em] min-w-0",
        colorClass,
        className,
      )}
    >
      <span className={cn(truncate && "min-w-0 truncate")}>{status}</span>
    </span>
  );
}
