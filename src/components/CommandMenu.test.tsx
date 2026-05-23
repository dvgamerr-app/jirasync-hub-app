import "@/test/jsdom-setup";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, mock, jest, spyOn } from "bun:test";
import { CommandMenu } from "@/components/CommandMenu";
import { useTaskStore, type TaskStore } from "@/store/task-store";
import type { Project, Task } from "@/types/jira";

mock.module("@/components/ui/command", () => ({
  CommandDialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => (open ? <div data-testid="command-dialog">{children}</div> : null),
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input data-testid="command-input" placeholder={placeholder} />
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => (
    <div data-testid="command-empty">{children}</div>
  ),
  CommandGroup: ({ heading, children }: { heading?: string; children: ReactNode }) => (
    <div data-testid={`group-${heading}`}>{children}</div>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    value?: string;
    onSelect?: () => void;
    className?: string;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

const project: Project = {
  id: "proj-account-1-ALPHA",
  orgId: "org-account-1",
  name: "Project Alpha",
  jiraProjectKey: "ALPHA",
  availableStatuses: [],
};
const task: Task = {
  id: "task-account-1-ALPHA-1",
  projectId: project.id,
  jiraTaskId: "ALPHA-1",
  title: "Fix login bug",
  description: null,
  status: "In Progress",
  type: "Task",
  severity: "High",
  storyLevel: 2,
  mandays: 1,
  assignee: "Alice",
  refUrl: "https://acme.atlassian.net/browse/ALPHA-1",
  note: null,
  isSynced: true,
  isDirty: false,
  createdAt: "2026-03-20T10:00:00.000Z",
  updatedAt: "2026-03-21T10:00:00.000Z",
};

describe("CommandMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSelectedTask: ReturnType<typeof spyOn>;
  let setSelectedProject: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useTaskStore.setState({
      tasks: [task],
      projects: [project],
      taskStatusFilter: "active" as const,
      selectedProjectId: null,
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
    } as Partial<TaskStore>);
    setSelectedTask = spyOn(useTaskStore.getState(), "setSelectedTask");
    setSelectedProject = spyOn(useTaskStore.getState(), "setSelectedProject");
    await act(async () => {
      root.render(<CommandMenu />);
    });
  });

  afterEach(async () => {
    setSelectedTask?.mockRestore?.();
    setSelectedProject?.mockRestore?.();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it("dialog is closed by default", () => {
    expect(container.querySelector('[data-testid="command-dialog"]')).toBeNull();
  });

  it("opens dialog on Ctrl+K", async () => {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    expect(container.querySelector('[data-testid="command-dialog"]')).not.toBeNull();
  });

  it("opens dialog on Meta+K (macOS)", async () => {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
      );
    });
    expect(container.querySelector('[data-testid="command-dialog"]')).not.toBeNull();
  });

  it("does not open on plain K keydown without modifier", async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    });
    expect(container.querySelector('[data-testid="command-dialog"]')).toBeNull();
  });

  it("lists tasks and projects when dialog is open", async () => {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("ALPHA-1");
    expect(text).toContain("Fix login bug");
    expect(text).toContain("Project Alpha");
  });

  it("selects task: calls setSelectedProject and setSelectedTask then closes dialog", async () => {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    const taskButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Fix login bug"),
    );
    expect(taskButton).toBeDefined();
    await act(async () => {
      taskButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSelectedProject).toHaveBeenCalledWith(task.projectId);
    expect(setSelectedTask).toHaveBeenCalledWith(task.id);
    expect(container.querySelector('[data-testid="command-dialog"]')).toBeNull();
  });

  it("selects project: calls setSelectedProject, clears task selection, then closes dialog", async () => {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    const projectButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Project Alpha"),
    );
    expect(projectButton).toBeDefined();
    await act(async () => {
      projectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSelectedProject).toHaveBeenCalledWith(project.id);
    expect(setSelectedTask).toHaveBeenCalledWith(null);
    expect(container.querySelector('[data-testid="command-dialog"]')).toBeNull();
  });

  it("removes keydown listener on unmount", async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<CommandMenu />);
    });
    await act(async () => {
      root.unmount();
    });
    container.remove();
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
    });
    expect(document.querySelector('[data-testid="command-dialog"]')).toBeNull();
  });
});
