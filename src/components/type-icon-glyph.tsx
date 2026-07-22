import { Bug, BookOpen, ClipboardList, Zap, Info, FileText } from "lucide-react";

export function inferTypeIcon(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes("bug")) return <Bug className="text-destructive h-3.5 w-3.5" />;
  if (lower.includes("story")) return <BookOpen className="text-primary h-3.5 w-3.5" />;
  if (lower.includes("epic")) return <Zap className="text-violet-500 h-3.5 w-3.5" />;
  if (lower.includes("sub")) return <Info className="text-muted-foreground h-3.5 w-3.5" />;
  if (lower.includes("task")) return <ClipboardList className="text-muted-foreground h-3.5 w-3.5" />;
  return <FileText className="text-muted-foreground h-3.5 w-3.5" />;
}
