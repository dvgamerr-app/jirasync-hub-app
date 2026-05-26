import { Bug, BookOpen, ClipboardList, Zap, Info, FileText } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function inferTypeIcon(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes("bug")) return <Bug className="text-destructive h-3.5 w-3.5" />;
  if (lower.includes("story")) return <BookOpen className="text-primary h-3.5 w-3.5" />;
  if (lower.includes("epic")) return <Zap className="text-violet-500 h-3.5 w-3.5" />;
  if (lower.includes("sub")) return <Info className="text-muted-foreground h-3.5 w-3.5" />;
  if (lower.includes("task")) return <ClipboardList className="text-muted-foreground h-3.5 w-3.5" />;
  return <FileText className="text-muted-foreground h-3.5 w-3.5" />;
}

export function TypeIcon({ type }: { type: string | null }) {
  if (!type) return <span className="text-muted-foreground text-[12px]">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center justify-center">{inferTypeIcon(type)}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        {type}
      </TooltipContent>
    </Tooltip>
  );
}
