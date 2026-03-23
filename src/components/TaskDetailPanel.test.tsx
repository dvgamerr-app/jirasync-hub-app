import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { useTaskStore } from "@/store/task-store";
import type { Project, Task } from "@/types/jira";

vi.mock("@/lib/desktop", () => ({
  openExternal: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string | null }) => <span>{status ?? "—"}</span>,
}));

vi.mock("@/components/LogWorkModal", () => ({
  LogWorkModal: () => <button type="button">Log Time</button>,
  formatMinutes: (minutes: number) => `${minutes}m`,
  parseTimeInput: () => null,
}));

const project: Project = {
  id: "proj-1",
  orgId: "org-1",
  name: "Project Alpha",
  jiraProjectKey: "ALPHA",
  availableStatuses: ["To Do", "In Progress", "Done"],
};

const tasks: Task[] = [
  {
    id: "task-1",
    projectId: project.id,
    jiraTaskId: "ALPHA-1",
    title: "First task",
    description: "First description body",
    status: "To Do",
    type: "Task",
    severity: "Medium",
    storyLevel: 1,
    mandays: 1,
    assignee: "Alice",
    refUrl: "https://example.com/ALPHA-1",
    note: "Local note",
    isSynced: true,
    isDirty: false,
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-21T10:00:00.000Z",
  },
  {
    id: "task-2",
    projectId: project.id,
    jiraTaskId: "ALPHA-2",
    title: "Second task",
    description: JSON.stringify({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second description body" }],
        },
      ],
    }),
    status: "In Progress",
    type: "Story",
    severity: "High",
    storyLevel: 2,
    mandays: 2,
    assignee: "Bob",
    refUrl: "https://example.com/ALPHA-2",
    note: null,
    isSynced: true,
    isDirty: false,
    createdAt: "2026-03-20T11:00:00.000Z",
    updatedAt: "2026-03-21T11:00:00.000Z",
  },
  {
    id: "task-3",
    projectId: project.id,
    jiraTaskId: "ALPHA-3",
    title: "Third task",
    description: JSON.stringify({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    }),
    status: "Done",
    type: "Bug",
    severity: "Low",
    storyLevel: null,
    mandays: null,
    assignee: null,
    refUrl: "https://example.com/ALPHA-3",
    note: null,
    isSynced: true,
    isDirty: false,
    createdAt: "2026-03-20T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z",
  },
];

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

describe("TaskDetailPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.open = vi.fn();

    useTaskStore.setState({
      organizations: [],
      projects: [project],
      tasks,
      workLogs: [],
      isLoaded: true,
      selectedProjectId: null,
      selectedTaskId: "task-1",
      taskStatusFilter: "active",
      taskDetailViewMode: "details",
    });

    await act(async () => {
      root.render(<TaskDetailPanel />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    useTaskStore.setState({
      organizations: [],
      projects: [],
      tasks: [],
      workLogs: [],
      isLoaded: false,
      selectedProjectId: null,
      selectedTaskId: null,
      taskStatusFilter: "active",
      taskDetailViewMode: "details",
    });
  });

  it("keeps the description toggle mode when switching between tasks with descriptions", async () => {
    expect(container.textContent).toContain("Show Description");
    expect(container.textContent).toContain("Status");

    const descriptionButton = findButton(container, "Show Description");
    expect(descriptionButton).toBeDefined();

    await act(async () => {
      descriptionButton?.click();
    });

    expect(useTaskStore.getState().taskDetailViewMode).toBe("description");
    expect(container.textContent).toContain("Hide Description");
    expect(container.textContent).toContain("First description body");
    expect(container.textContent).not.toContain("Status");

    await act(async () => {
      useTaskStore.setState({ selectedTaskId: "task-2" });
    });

    expect(container.textContent).toContain("Second description body");
    expect(container.textContent).toContain("Hide Description");
    expect(container.textContent).not.toContain("Status");
  });

  it("falls back to details and hides the description toggle for tasks without description", async () => {
    await act(async () => {
      useTaskStore.setState({
        selectedTaskId: "task-3",
        taskDetailViewMode: "description",
      });
    });

    expect(findButton(container, "Show Description")).toBeUndefined();
    expect(findButton(container, "Hide Description")).toBeUndefined();
    expect(container.textContent).toContain("Status");
    expect(container.textContent).not.toContain("Second description body");
  });
});
