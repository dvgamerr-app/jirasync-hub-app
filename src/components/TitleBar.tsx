import { Minus, Square, X } from "lucide-react";
import { windowControls } from "@/lib/window-rpc";

export function TitleBar() {
  return (
    <div className="electrobun-webkit-app-region-drag flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-background/95 backdrop-blur">
      <span className="pl-3 text-[13px] font-semibold text-foreground">JiraSync Hub</span>
      <div className="electrobun-webkit-app-region-no-drag flex hidden h-full items-center">
        <button
          onClick={windowControls.minimize}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={windowControls.maximize}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Maximize"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          onClick={windowControls.close}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
