import { Bug, BookOpen, ClipboardList, Zap, Info, FileText } from "lucide-react";

// Kept apart from TypeIcon.tsx: a file that exports a component must export only components,
// otherwise React Fast Refresh falls back to a full reload for it.
export function inferTypeIcon(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes("bug")) return <Bug className="text-destructive h-3.5 w-3.5" />;
  if (lower.includes("story")) return <BookOpen className="text-primary h-3.5 w-3.5" />;
  if (lower.includes("epic")) return <Zap className="h-3.5 w-3.5 text-violet-500" />;
  if (lower.includes("sub")) return <Info className="text-muted-foreground h-3.5 w-3.5" />;
  if (lower.includes("task"))
    return <ClipboardList className="text-muted-foreground h-3.5 w-3.5" />;
  return <FileText className="text-muted-foreground h-3.5 w-3.5" />;
}
