import "@/test/jsdom-setup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import Index from "@/pages/Index";
import { useTaskStore, type TaskStore } from "@/store/task-store";
import type { Project, Task, WorkLog } from "@/types/jira";

const exportDialogMock = mock();
const getJiraAccountsMock = mock();
const onSyncStatusMock = mock();
const startBackgroundSyncMock = mock();
const stopBackgroundSyncMock = mock();
const syncNowMock = mock();
const toastMock = mock();
const jiraSettingsDialogMock = mock();

mock.module("@/components/AppSidebar", () => ({ AppSidebar: () => <div>App Sidebar</div> }));
mock.module("@/components/TaskTable", () => ({ TaskTable: () => <div>Task Table</div> }));
mock.module("@/components/TaskDetailPanel", () => ({
  TaskDetailPanel: () => <div>Task Detail</div>,
}));
mock.module("@/components/CommandMenu", () => ({ CommandMenu: () => <div>Command Menu</div> }));
mock.module("@/components/ThemeToggle", () => ({ ThemeToggle: () => <div>Theme Toggle</div> }));
mock.module("@/components/MobileSidebar", () => ({
  MobileSidebar: () => <div>Mobile Sidebar</div>,
}));

mock.module("@/components/ExportDialog", () => ({
  ExportDialog: (props: { open: boolean; tasks: Array<{ id: string }> }) => {
    exportDialogMock(props);
    return (
      <div
        data-open={String(props.open)}
        data-task-count={props.tasks.length}
        data-testid="export-dialog"
      />
    );
  },
}));

mock.module("@/components/JiraSettings", () => ({
  JiraSettingsDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    jiraSettingsDialogMock({ open, onOpenChange });
    return (
      <div data-open={String(open)}>
        Jira Settings
        {open ? (
          <button type="button" onClick={() => onOpenChange(false)}>
            Close Jira Settings
          </button>
        ) : null}
      </div>
    );
  },
}));

mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
mock.module("@/hooks/use-toast", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));
mock.module("@/lib/sync-service", () => ({
  onSyncStatus: (...args: unknown[]) => onSyncStatusMock(...args),
  startBackgroundSync: (...args: unknown[]) => startBackgroundSyncMock(...args),
  stopBackgroundSync: (...args: unknown[]) => stopBackgroundSyncMock(...args),
  syncNow: (...args: unknown[]) => syncNowMock(...args),
}));
mock.module("@/lib/jira-db", () => ({
  getJiraAccounts: () => getJiraAccountsMock(),
  getStoryPointFieldMap: () => ({}),
  db: {
    organizations: {
      toArray: mock(async () => []),
      put: mock(),
      delete: mock(),
      where: mock(() => ({
        equals: mock(() => ({ toArray: mock(async () => []), delete: mock() })),
      })),
    },
    projects: {
      toArray: mock(async () => []),
      put: mock(),
      where: mock(() => ({
        equals: mock(() => ({ toArray: mock(async () => []), delete: mock() })),
      })),
    },
    tasks: {
      toArray: mock(async () => []),
      put: mock(),
      get: mock(async () => undefined),
      where: mock(() => ({
        equals: mock(() => ({ toArray: mock(async () => []), delete: mock() })),
      })),
      toCollection: mock(() => ({ filter: () => ({ delete: mock() }) })),
    },
    workLogs: {
      toArray: mock(async () => []),
      put: mock(),
      bulkPut: mock(),
      delete: mock(),
      bulkDelete: mock(),
      where: mock(() => ({
        equals: mock(() => ({ toArray: mock(async () => []), delete: mock() })),
      })),
      toCollection: mock(() => ({ filter: () => ({ delete: mock() }) })),
    },
    syncMeta: { put: mock(), get: mock(async () => undefined) },
  },
}));

const projectAlpha: Project = {
  id: "proj-account-1-ALPHA",
  orgId: "org-account-1",
  name: "Project Alpha",
  jiraProjectKey: "ALPHA",
  availableStatuses: [],
};

const projectBeta: Project = {
  id: "proj-account-1-BETA",
  orgId: "org-account-1",
  name: "Project Beta",
  jiraProjectKey: "BETA",
  availableStatuses: [],
};

function buildTask(id: string, projectId: string, jiraTaskId: string): Task {
  return {
    id,
    projectId,
    jiraTaskId,
    title: jiraTaskId,
    description: null,
    status: "To Do",
    type: "Task",
    severity: "Medium",
    storyLevel: 1,
    mandays: 1,
    assignee: "Alice",
    refUrl: `https://acme.atlassian.net/browse/${jiraTaskId}`,
    note: null,
    isSynced: true,
    isDirty: false,
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-21T10:00:00.000Z",
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(label),
  );
}

describe("Index", () => {
  let container: HTMLDivElement;
  let root: Root;

  let spies: Array<{ mockRestore(): void }>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    spies = [];

    getJiraAccountsMock.mockReturnValue([]);
    onSyncStatusMock.mockImplementation(() => mock());
    startBackgroundSyncMock.mockReset();
    stopBackgroundSyncMock.mockReset();
    syncNowMock.mockReset();
    exportDialogMock.mockReset();
    jiraSettingsDialogMock.mockReset();

    const alphaTask = buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1");
    // Use real computed functions with proper raw state

    useTaskStore.setState({
      tasks: [alphaTask],
      projects: [projectAlpha, projectBeta],
      workLogs: [] as WorkLog[],
      selectedTaskId: null,
      selectedProjectId: projectAlpha.id,
      taskStatusFilter: "active" as const,
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
      isLoaded: true,
    } as Partial<TaskStore>);

    // Spy on loadFromDB/reloadFromDB to prevent overwriting test state
    const loadSpy = spyOn(useTaskStore.getState(), "loadFromDB").mockResolvedValue(undefined);
    const reloadSpy = spyOn(useTaskStore.getState(), "reloadFromDB").mockResolvedValue(undefined);
    spies.push(loadSpy, reloadSpy);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    spies.forEach((s) => s.mockRestore());
    jest.clearAllMocks();
  });

  it("passes all tasks to ExportDialog even when a project filter is active", async () => {
    const alphaTask = buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1");
    const betaTask = buildTask("task-account-1-BETA-1", projectBeta.id, "BETA-1");
    useTaskStore.setState({
      tasks: [alphaTask, betaTask],
      selectedProjectId: projectAlpha.id,
    } as Partial<TaskStore>);

    await act(async () => {
      root.render(<Index />);
    });

    const exportDialog = container.querySelector('[data-testid="export-dialog"]');
    expect(exportDialog?.getAttribute("data-task-count")).toBe("2");
    expect(container.textContent).toContain("Project Alpha");
  });

  it("keeps the export button enabled when the selected project has no visible tasks but other tasks exist", async () => {
    const alphaTask = buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1");
    // selectedProjectId = beta, but tasks only have alpha => filteredTasks = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useTaskStore.setState({ tasks: [alphaTask], selectedProjectId: projectBeta.id } as any);

    await act(async () => {
      root.render(<Index />);
    });

    const exportButton = findButton(container, "Export");
    expect(container.textContent).toContain("No matching tasks");
    expect(container.textContent).toContain("No active tasks match the current project selection.");
    expect(exportButton).toBeDefined();
    expect(exportButton?.disabled).toBe(false);
  });

  it("lets users switch the task status filter", async () => {
    const spy = spyOn(useTaskStore.getState(), "setTaskStatusFilter");
    spies.push(spy);

    await act(async () => {
      root.render(<Index />);
    });

    const doneFilterButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Done",
    );
    expect(doneFilterButton).toBeDefined();

    await act(async () => {
      doneFilterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(spy).toHaveBeenCalledWith("done");
  });

  it("reloads the store when Jira Settings closes so sidebar ordering can refresh", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useTaskStore.setState({ tasks: [], projects: [], selectedProjectId: null } as any);
    getJiraAccountsMock.mockReturnValue([
      {
        id: "account-1",
        name: "Acme",
        instanceUrl: "https://acme.atlassian.net",
        email: "dev@acme.test",
        apiToken: "token",
      },
    ]);

    // Use the reloadFromDB spy from beforeEach (restored in afterEach)
    const reloadSpy = spies[1] as ReturnType<typeof spyOn>;

    await act(async () => {
      root.render(<Index />);
    });

    const openSettingsButton = findButton(container, "Jira Settings");
    expect(openSettingsButton).toBeDefined();

    await act(async () => {
      openSettingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const closeSettingsButton = findButton(container, "Close Jira Settings");
    expect(closeSettingsButton).toBeDefined();

    await act(async () => {
      closeSettingsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(reloadSpy).toHaveBeenCalledOnce();
  });
});
