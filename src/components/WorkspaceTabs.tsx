import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

const TABS = [
  { path: "/", label: "Task Manager" },
  { path: "/kanban", label: "Kanban" },
];

/**
 * Task Manager and Kanban are peer pages, not a drill-down — switching between them
 * is a tab action, not "back" navigation. Keeping this control in the same on-screen
 * position everywhere (the title bar) matches Jakob's Law / Nielsen's consistency
 * heuristic: navigation stays where the user learned to expect it.
 */
interface WorkspaceTabsProps {
  /** Called after navigating — e.g. to close a mobile sheet. */
  onNavigate?: () => void;
  /** "panel": boxed style for a sidebar/page header. "compact": slim style for the title bar. */
  variant?: "panel" | "compact";
}

export function WorkspaceTabs({ onNavigate, variant = "panel" }: WorkspaceTabsProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const isKanban = location.pathname.startsWith("/kanban");
  const compact = variant === "compact";

  return (
    <div
      className={cn(
        "flex items-center rounded-md p-0.5",
        compact ? "bg-foreground/[0.06]" : "border-border bg-muted/30 border",
      )}
    >
      {TABS.map((tab) => {
        const active = tab.path === "/kanban" ? isKanban : !isKanban;
        return (
          <button
            key={tab.path}
            type="button"
            onClick={() => {
              navigate(tab.path);
              onNavigate?.();
            }}
            className={cn(
              "rounded-[5px] font-medium transition-colors",
              compact ? "h-6 px-2.5 text-[11px]" : "min-h-7 flex-1 px-2.5 py-1 text-[12px]",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
