import type { MouseEvent } from "react";
import { Minus, Square, X } from "lucide-react";
import {
  closeWindow,
  minimizeWindow,
  startWindowDragging,
  toggleWindowMaximize,
} from "@/lib/desktop";

export function TitleBar() {
  const onDragMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    if (event.detail === 2) {
      void toggleWindowMaximize();
      return;
    }

    void startWindowDragging();
  };

  return (
    <div className="flex h-10 shrink-0 select-none items-center justify-between border-b border-border bg-card/85 backdrop-blur">
      <div className="flex h-full min-w-0 flex-1 items-center px-3" onMouseDown={onDragMouseDown}>
        <span className="truncate text-[13px] font-semibold tracking-wide text-foreground">
          JiraSync Hub
        </span>
      </div>

      <div className="flex h-full items-center border-l border-border/70">
        <button
          type="button"
          onClick={() => void minimizeWindow()}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void toggleWindowMaximize()}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Maximize"
          aria-label="Toggle maximize window"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => void closeWindow()}
          className="flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          title="Close"
          aria-label="Close window"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
