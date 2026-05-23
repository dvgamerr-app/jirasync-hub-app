import "@/test/jsdom-setup";
import { act, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, mock, jest, spyOn } from "bun:test";
import { TaskTable } from "@/components/TaskTable";
import { useTaskStore, type TaskStore } from "@/store/task-store";
import type { Project, Task, WorkLog } from "@/types/jira";

mock.module("@/lib/desktop", () => ({ openExternal: mock() }));
mock.module("@/components/LogWorkModal", () => ({
  LogWorkModal: () => <button type="button">Log Time</button>,
}));
mock.module("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: (i: number) => number;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * estimateSize(i),
        end: (i + 1) * estimateSize(i),
        size: estimateSize(i),
        key: i,
      })),
    getTotalSize: () => count * 40,
  }),
}));
mock.module("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({
    children,
    className,
    align,
  }: {
    children: ReactNode;
    className?: string;
    align?: string;
  }) => (
    <div data-align={align} className={className}>
      {children}
    </div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const project: Project = {
  id: "proj-1",
  orgId: "org-1",
  name: "Project Alpha",
  jiraProjectKey: "ALPHA",
  availableStatuses: ["To Do", "In Progress", "Done"],
};
const task: Task = {
  id: "task-1",
  projectId: project.id,
  jiraTaskId: "ALPHA-1",
  title: "Task Alpha",
  description: null,
  status: "To Do",
  type: "Task",
  severity: "Medium",
  storyLevel: 1,
  mandays: 1,
  assignee: "Alice",
  refUrl: "https://example.com/ALPHA-1",
  note: "Keep me",
  isSynced: true,
  isDirty: false,
  createdAt: "2026-03-20T10:00:00.000Z",
  updatedAt: "2026-03-21T10:00:00.000Z",
};
const workLogs: WorkLog[] = [
  {
    id: "wl-1",
    taskId: task.id,
    timeSpentMinutes: 60,
    logDate: "2026-03-20",
    comment: null,
    createdAt: "2026-03-20T11:00:00.000Z",
    jiraWorklogId: "1",
  },
  {
    id: "wl-2",
    taskId: task.id,
    timeSpentMinutes: 30,
    logDate: "2026-03-21",
    comment: "Follow-up",
    createdAt: "2026-03-21T11:00:00.000Z",
    jiraWorklogId: "2",
  },
];

describe("TaskTable", () => {
  let container: HTMLDivElement;
  let root: Root;

  let spies: Array<{ mockRestore(): void }>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    spies = [];
    // Set raw state - let real getFilteredTasks compute

    useTaskStore.setState({
      tasks: [task],
      workLogs,
      projects: [project],
      selectedTaskId: null,
      selectedProjectId: null,
      taskStatusFilter: "active" as const,
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
    } as Partial<TaskStore>);
    await act(async () => {
      root.render(<TaskTable />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    spies.forEach((s) => s.mockRestore());
    jest.clearAllMocks();
  });

  it("does not mark note dirty when the inline editor is blurred without changes", async () => {
    const spy = spyOn(useTaskStore.getState(), "updateTaskNote");
    spies.push(spy);
    await act(async () => {
      const noteSpan =
        Array.from(container.querySelectorAll("span")).find(
          (node) => node.textContent === "Keep me",
        ) ?? null;
      noteSpan?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = container.querySelector('input[aria-label="Edit note for task-1"]');
    expect(input).not.toBeNull();
    await act(async () => {
      input?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not mark mandays dirty when the inline editor is blurred without changes", async () => {
    const spy = spyOn(useTaskStore.getState(), "updateTaskMandays");
    spies.push(spy);
    await act(async () => {
      const mandaySpan =
        Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "1d") ??
        null;
      mandaySpan?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = container.querySelector('input[aria-label="Edit mandays for task-1"]');
    expect(input).not.toBeNull();
    await act(async () => {
      input?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("aggregates total logged time once per task row", () => {
    expect(container.textContent).toContain("1h 30m");
  });

  it("renders the story tooltip left aligned with compact text sizing", () => {
    const tooltip = container.querySelector('div[data-align="start"]');
    expect(tooltip?.textContent).toContain("Estimation Rule");
    expect(tooltip?.getAttribute("data-align")).toBe("start");
    expect(tooltip?.className).toContain("text-left");
    expect(tooltip?.className).toContain("text-[11px]");
    expect(tooltip?.className).toContain("max-w-[210px]");
  });

  it("marks rows red when a non-story task still has story points", async () => {
    await act(async () => {
      root.render(<TaskTable />);
    });
    const row = container.querySelector("tbody tr");
    expect(row?.className).toContain("bg-red-50/80");
    expect(row?.textContent).toContain("1");
  });
});
