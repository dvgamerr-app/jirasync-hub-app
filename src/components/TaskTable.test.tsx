import { act, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskTable } from "@/components/TaskTable";
import type { Project, Task, WorkLog } from "@/types/jira";

const useTaskStoreMock = vi.fn();

vi.mock("@/store/task-store", () => ({
  useTaskStore: () => useTaskStoreMock(),
}));

vi.mock("@/lib/desktop", () => ({
  openExternal: vi.fn(),
}));

vi.mock("@/components/LogWorkModal", () => ({
  LogWorkModal: () => <button type="button">Log Time</button>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
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

function buildStoreState() {
  return {
    selectedTaskId: null,
    setSelectedTask: vi.fn(),
    getFilteredTasks: () => [task],
    workLogs,
    projects: [project],
    updateTaskStatus: vi.fn(),
    addWorkLog: vi.fn(),
    updateTaskType: vi.fn(),
    updateTaskSeverity: vi.fn(),
    updateTaskNote: vi.fn(),
    updateTaskMandays: vi.fn(),
  };
}

function clickElement(element: Element | null) {
  if (!element) {
    throw new Error("Expected element to exist");
  }

  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("TaskTable", () => {
  let container: HTMLDivElement;
  let root: Root;
  let storeState: ReturnType<typeof buildStoreState>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    storeState = buildStoreState();
    useTaskStoreMock.mockImplementation(() => storeState);

    await act(async () => {
      root.render(<TaskTable />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("does not mark note dirty when the inline editor is blurred without changes", async () => {
    await act(async () => {
      clickElement(Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "Keep me") ?? null);
    });

    const input = container.querySelector('input[aria-label="Edit note for task-1"]');
    expect(input).not.toBeNull();

    await act(async () => {
      input?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(storeState.updateTaskNote).not.toHaveBeenCalled();
  });

  it("does not mark mandays dirty when the inline editor is blurred without changes", async () => {
    await act(async () => {
      clickElement(
        Array.from(container.querySelectorAll("span")).find((node) => node.textContent === "1d") ??
          null,
      );
    });

    const input = container.querySelector('input[aria-label="Edit mandays for task-1"]');
    expect(input).not.toBeNull();

    await act(async () => {
      input?.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(storeState.updateTaskMandays).not.toHaveBeenCalled();
  });

  it("aggregates total logged time once per task row", () => {
    expect(container.textContent).toContain("1h 30m");
  });
});
