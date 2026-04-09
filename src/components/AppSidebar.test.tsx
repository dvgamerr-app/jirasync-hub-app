import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/components/AppSidebar";

const useTaskStoreMock = vi.fn();
const getLastSyncTimeMock = vi.fn(async () => null as string | null);

vi.mock("@/store/task-store", () => ({
  useTaskStore: () => useTaskStoreMock(),
}));

vi.mock("@/lib/sync-service", () => ({
  getLastSyncTime: () => getLastSyncTimeMock(),
}));

function buildStoreState(overrides: Record<string, unknown> = {}) {
  return {
    organizations: [
      { id: "org-1", name: "Acme", jiraInstanceUrl: "https://acme.test", lastSyncedAt: null },
    ],
    selectedProjectId: null as string | null,
    setSelectedProject: vi.fn(),
    getVisibleProjects: () => [
      {
        id: "proj-1",
        orgId: "org-1",
        name: "Project Alpha",
        jiraProjectKey: "ALPHA",
        availableStatuses: [],
      },
    ],
    ...overrides,
  };
}

describe("AppSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getLastSyncTimeMock.mockResolvedValue(null);
    useTaskStoreMock.mockImplementation(() => buildStoreState());

    await act(async () => {
      root.render(<AppSidebar onOpenSettings={vi.fn()} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("shows only projects that still have visible tasks after filtering", () => {
    expect(container.textContent).toContain("Project Alpha");
    expect(container.textContent).not.toContain("Project Beta");
  });

  it("clicking All Tasks calls setSelectedProject(null)", async () => {
    const storeState = buildStoreState({ selectedProjectId: "proj-1" });
    useTaskStoreMock.mockImplementation(() => storeState);

    await act(async () => {
      root.render(<AppSidebar onOpenSettings={vi.fn()} />);
    });

    const allTasksBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("All Tasks"),
    );
    await act(async () => {
      allTasksBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(storeState.setSelectedProject).toHaveBeenCalledWith(null);
  });

  it("clicking a project calls setSelectedProject with the project id", async () => {
    const storeState = buildStoreState();
    useTaskStoreMock.mockImplementation(() => storeState);

    await act(async () => {
      root.render(<AppSidebar onOpenSettings={vi.fn()} />);
    });

    const alphaBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Project Alpha"),
    );
    await act(async () => {
      alphaBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(storeState.setSelectedProject).toHaveBeenCalledWith("proj-1");
  });

  it("clicking Jira Settings calls onOpenSettings", async () => {
    const onOpenSettings = vi.fn();
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

    // Remount so the useEffect([]) fires again with the updated mock
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<AppSidebar onOpenSettings={vi.fn()} />);
    });
    // Flush the .then(setLastSync) microtask
    await act(async () => {});

    // The sidebar renders "Synced X ago" text
    expect(container.textContent).toContain("Synced");
  });

  it("does not show sync label when getLastSyncTime returns null", async () => {
    getLastSyncTimeMock.mockResolvedValue(null);

    await act(async () => {
      root.render(<AppSidebar onOpenSettings={vi.fn()} />);
    });

    expect(container.textContent).not.toContain("Synced");
  });
});
