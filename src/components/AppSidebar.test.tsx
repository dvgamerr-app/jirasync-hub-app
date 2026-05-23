import "@/test/jsdom-setup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, mock, jest, spyOn } from "bun:test";
import { AppSidebar } from "@/components/AppSidebar";
import { useTaskStore, type TaskStore } from "@/store/task-store";
import type { Task } from "@/types/jira";

const getLastSyncTimeMock = mock(async () => null as string | null);

mock.module("@/lib/sync-service", () => ({
  getLastSyncTime: () => getLastSyncTimeMock(),
  onSyncStatus: () => () => {},
}));

const projectAlpha = {
  id: "proj-1",
  orgId: "org-1",
  name: "Project Alpha",
  jiraProjectKey: "ALPHA",
  availableStatuses: [],
};
const org = { id: "org-1", name: "Acme", jiraInstanceUrl: "https://acme.test", lastSyncedAt: null };
const activeTask: Task = {
  id: "task-1",
  projectId: "proj-1",
  jiraTaskId: "ALPHA-1",
  title: "Task",
  description: null,
  status: "In Progress",
  type: "Task",
  severity: "Medium",
  storyLevel: null,
  mandays: null,
  assignee: null,
  refUrl: null,
  note: null,
  isSynced: true,
  isDirty: false,
  createdAt: "2026-03-20T10:00:00.000Z",
  updatedAt: "2026-03-21T10:00:00.000Z",
};

describe("AppSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  let spies: Array<{ mockRestore(): void }>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    spies = [];
    getLastSyncTimeMock.mockResolvedValue(null);
    // Use real computed functions - set raw state correctly

    useTaskStore.setState({
      organizations: [org],
      projects: [projectAlpha],
      tasks: [activeTask],
      workLogs: [],
      selectedProjectId: null,
      selectedTaskId: null,
      taskStatusFilter: "active" as const,
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
    } as Partial<TaskStore>);
    await act(async () => {
      root.render(<AppSidebar onOpenSettings={mock()} />);
    });
    await act(async () => {}); // flush getLastSyncTime().then(setLastSync) from useEffect
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    spies.forEach((s) => s.mockRestore());
    jest.clearAllMocks();
  });

  it("shows only projects that still have visible tasks after filtering", () => {
    expect(container.textContent).toContain("Project Alpha");
    expect(container.textContent).not.toContain("Project Beta");
  });

  it("clicking All Tasks calls setSelectedProject(null)", async () => {
    const spy = spyOn(useTaskStore.getState(), "setSelectedProject");
    spies.push(spy);
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useTaskStore.setState({ selectedProjectId: "proj-1" } as any);
      root.render(<AppSidebar onOpenSettings={mock()} />);
    });
    const allTasksBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("All Tasks"),
    );
    await act(async () => {
      allTasksBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(spy).toHaveBeenCalledWith(null);
  });

  it("clicking a project calls setSelectedProject with the project id", async () => {
    const spy = spyOn(useTaskStore.getState(), "setSelectedProject");
    spies.push(spy);
    const alphaBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Project Alpha"),
    );
    await act(async () => {
      alphaBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(spy).toHaveBeenCalledWith("proj-1");
  });

  it("clicking Jira Settings calls onOpenSettings", async () => {
    const onOpenSettings = mock();
    await act(async () => {
      root.render(<AppSidebar onOpenSettings={onOpenSettings} />);
    });
    const settingsBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Jira Settings"),
    );
    await act(async () => {
      settingsBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows last-synced timestamp when sync-service returns a date", async () => {
    getLastSyncTimeMock.mockResolvedValue("2026-04-09T08:00:00.000Z");
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<AppSidebar onOpenSettings={mock()} />);
    });
    await act(async () => {});
    expect(container.textContent).toContain("Synced");
  });

  it("does not show sync label when getLastSyncTime returns null", async () => {
    getLastSyncTimeMock.mockResolvedValue(null);
    await act(async () => {
      root.render(<AppSidebar onOpenSettings={mock()} />);
    });
    expect(container.textContent).not.toContain("Synced");
  });
});
