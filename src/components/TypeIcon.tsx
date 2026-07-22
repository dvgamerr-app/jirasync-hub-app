import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { inferTypeIcon } from "@/components/type-icon-glyph";

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
