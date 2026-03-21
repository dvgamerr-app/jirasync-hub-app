import { Minus, Square, X } from "lucide-react";
import { windowControls } from "@/lib/window-rpc";

export function TitleBar() {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-between bg-background border-b border-border select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <span className="pl-3 text-[13px] font-semibold text-foreground">
        JiraSync Hub
      </span>
      <div
        className="flex h-full items-center"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={windowControls.minimize}
          className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={windowControls.maximize}
          className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          title="Maximize"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          onClick={windowControls.close}
          className="flex h-full w-11 items-center justify-center text-muted-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
