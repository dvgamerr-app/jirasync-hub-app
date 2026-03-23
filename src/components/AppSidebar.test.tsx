import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "@/components/AppSidebar";

const useTaskStoreMock = vi.fn();

vi.mock("@/store/task-store", () => ({
  useTaskStore: () => useTaskStoreMock(),
}));

vi.mock("@/lib/sync-service", () => ({
  getLastSyncTime: vi.fn(async () => null),
}));

describe("AppSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useTaskStoreMock.mockImplementation(() => ({
      organizations: [{ id: "org-1", name: "Acme", jiraInstanceUrl: "https://acme.test", lastSyncedAt: null }],
      selectedProjectId: null,
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
    }));

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
});
