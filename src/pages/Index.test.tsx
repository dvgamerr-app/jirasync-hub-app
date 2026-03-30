import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Index from "@/pages/Index";
import type { Project, Task, WorkLog } from "@/types/jira";

const useTaskStoreMock = vi.fn();
const exportDialogMock = vi.fn();
const getJiraAccountsMock = vi.fn();
const onSyncStatusMock = vi.fn();
const startBackgroundSyncMock = vi.fn();
const stopBackgroundSyncMock = vi.fn();
const syncNowMock = vi.fn();
const toastMock = vi.fn();
const jiraSettingsDialogMock = vi.fn();

vi.mock("@/store/task-store", () => ({
  useTaskStore: () => useTaskStoreMock(),
}));

vi.mock("@/components/AppSidebar", () => ({
  AppSidebar: () => <div>App Sidebar</div>,
}));

vi.mock("@/components/TaskTable", () => ({
  TaskTable: () => <div>Task Table</div>,
}));

vi.mock("@/components/TaskDetailPanel", () => ({
  TaskDetailPanel: () => <div>Task Detail</div>,
}));

vi.mock("@/components/CommandMenu", () => ({
  CommandMenu: () => <div>Command Menu</div>,
}));

vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => <div>Theme Toggle</div>,
}));

vi.mock("@/components/MobileSidebar", () => ({
  MobileSidebar: () => <div>Mobile Sidebar</div>,
}));

vi.mock("@/components/ExportDialog", () => ({
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

vi.mock("@/components/JiraSettings", () => ({
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

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock("@/lib/sync-service", () => ({
  onSyncStatus: (...args: unknown[]) => onSyncStatusMock(...args),
  startBackgroundSync: (...args: unknown[]) => startBackgroundSyncMock(...args),
  stopBackgroundSync: (...args: unknown[]) => stopBackgroundSyncMock(...args),
  syncNow: (...args: unknown[]) => syncNowMock(...args),
}));

vi.mock("@/lib/jira-db", () => ({
  getJiraAccounts: () => getJiraAccountsMock(),
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

type IndexStoreState = {
  tasks: Task[];
  selectedTaskId: string | null;
  selectedProjectId: string | null;
  taskStatusFilter: "active" | "done" | "all";
  getFilteredTasks: () => Task[];
  projects: Project[];
  workLogs: WorkLog[];
  syncAllDirtyTasks: () => Promise<void>;
  getDirtyTaskCount: () => number;
  loadFromDB: () => Promise<void>;
  reloadFromDB: () => Promise<void>;
  setTaskStatusFilter: (filter: "active" | "done" | "all") => void;
  isLoaded: boolean;
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

function buildStoreState(overrides?: Partial<IndexStoreState>): IndexStoreState {
  return {
    ...buildBaseStoreState(),
    ...overrides,
  };
}

function buildBaseStoreState(): IndexStoreState {
  return {
    tasks: [buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1")],
    selectedTaskId: null,
    selectedProjectId: projectAlpha.id,
    taskStatusFilter: "active" as const,
    getFilteredTasks: () => [buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1")],
    projects: [projectAlpha, projectBeta],
    workLogs: [],
    syncAllDirtyTasks: vi.fn(async () => undefined),
    getDirtyTaskCount: () => 0,
    loadFromDB: vi.fn(async () => undefined),
    reloadFromDB: vi.fn(async () => undefined),
    setTaskStatusFilter: vi.fn(),
    isLoaded: true,
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

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    getJiraAccountsMock.mockReturnValue([]);
    onSyncStatusMock.mockImplementation(() => vi.fn());
    startBackgroundSyncMock.mockReset();
    stopBackgroundSyncMock.mockReset();
    syncNowMock.mockReset();
    exportDialogMock.mockReset();
    jiraSettingsDialogMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("passes all tasks to ExportDialog even when a project filter is active", async () => {
    const alphaTask = buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1");
    const betaTask = buildTask("task-account-1-BETA-1", projectBeta.id, "BETA-1");

    useTaskStoreMock.mockImplementation(() =>
      buildStoreState({
        tasks: [alphaTask, betaTask],
        selectedProjectId: projectAlpha.id,
        getFilteredTasks: () => [alphaTask],
      }),
    );

    await act(async () => {
      root.render(<Index />);
    });

    const exportDialog = container.querySelector('[data-testid="export-dialog"]');

    expect(exportDialog?.getAttribute("data-task-count")).toBe("2");
    expect(container.textContent).toContain("Project Alpha");
  });

  it("keeps the export button enabled when the selected project has no visible tasks but other tasks exist", async () => {
    const alphaTask = buildTask("task-account-1-ALPHA-1", projectAlpha.id, "ALPHA-1");

    useTaskStoreMock.mockImplementation(() =>
      buildStoreState({
        tasks: [alphaTask],
        selectedProjectId: projectBeta.id,
        getFilteredTasks: () => [],
      }),
    );

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
    const storeState = buildStoreState();
    useTaskStoreMock.mockImplementation(() => storeState);

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

    expect(storeState.setTaskStatusFilter).toHaveBeenCalledWith("done");
  });

  it("reloads the store when Jira Settings closes so sidebar ordering can refresh", async () => {
    const storeState = buildStoreState({
      tasks: [],
      projects: [],
      selectedProjectId: null,
      getFilteredTasks: () => [],
      reloadFromDB: vi.fn(async () => undefined),
    });
    useTaskStoreMock.mockImplementation(() => storeState);
    getJiraAccountsMock.mockReturnValue([
      {
        id: "account-1",
        name: "Acme",
        instanceUrl: "https://acme.atlassian.net",
        email: "dev@acme.test",
        apiToken: "token",
      },
    ]);

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

    expect(storeState.reloadFromDB).toHaveBeenCalledOnce();
  });
});
