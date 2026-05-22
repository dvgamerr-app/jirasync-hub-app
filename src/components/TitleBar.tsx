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
    <div className="border-border bg-card/85 flex h-10 shrink-0 items-center justify-between border-b backdrop-blur select-none">
      <div className="flex h-full min-w-0 flex-1 items-center px-3" onMouseDown={onDragMouseDown}>
        <span className="text-foreground truncate text-[13px] font-semibold tracking-wide">
          JiraSync Hub
        </span>
      </div>

      <div className="border-border/70 flex h-full items-center border-l">
        <button
          type="button"
          onClick={() => void minimizeWindow()}
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex h-full w-11 items-center justify-center"
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void toggleWindowMaximize()}
          className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex h-full w-11 items-center justify-center"
          title="Maximize"
          aria-label="Toggle maximize window"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => void closeWindow()}
          className="text-muted-foreground hover:bg-destructive hover:text-destructive-foreground flex h-full w-11 items-center justify-center"
          title="Close"
          aria-label="Close window"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
