import "@/test/jsdom-setup";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, mock, jest, spyOn } from "bun:test";
import { MobileSidebar } from "@/components/MobileSidebar";
import { useTaskStore, type TaskStore } from "@/store/task-store";
import type { Organization, Project, Task } from "@/types/jira";

mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));
mock.module("@/components/ui/sheet", () => ({
  Sheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <div data-open={String(open)} data-testid="sheet">
      <button type="button" data-testid="sheet-open-toggle" onClick={() => onOpenChange(!open)} />
      {children}
    </div>
  ),
  SheetTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const org: Organization = {
  id: "org-account-1",
  name: "Acme",
  jiraInstanceUrl: "https://acme.atlassian.net",
  lastSyncedAt: null,
};
const projectAlpha: Project = {
  id: "proj-account-1-ALPHA",
  orgId: org.id,
  name: "Project Alpha",
  jiraProjectKey: "ALPHA",
  availableStatuses: [],
};
const projectBeta: Project = {
  id: "proj-account-1-BETA",
  orgId: org.id,
  name: "Project Beta",
  jiraProjectKey: "BETA",
  availableStatuses: [],
};

function makeActiveTask(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    jiraTaskId: id,
    title: id,
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
}

describe("MobileSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onOpenSettings: ReturnType<typeof mock>;

  let spies: Array<{ mockRestore(): void }>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenSettings = mock();
    spies = [];
    // Use real computed functions with proper raw state

    useTaskStore.setState({
      organizations: [org],
      projects: [projectAlpha, projectBeta],
      tasks: [makeActiveTask("t1", projectAlpha.id), makeActiveTask("t2", projectBeta.id)],
      workLogs: [],
      selectedProjectId: null,
      selectedTaskId: null,
      taskStatusFilter: "active" as const,
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
    } as Partial<TaskStore>);
    await act(async () => {
      root.render(<MobileSidebar onOpenSettings={onOpenSettings} />);
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

  it("lists all visible projects", () => {
    expect(container.textContent).toContain("Project Alpha");
    expect(container.textContent).toContain("Project Beta");
  });

  it("shows All Tasks button", () => {
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent?.includes("All Tasks"))).toBe(true);
  });

  it("clicking All Tasks calls setSelectedProject(null)", async () => {
    const spy = spyOn(useTaskStore.getState(), "setSelectedProject");
    spies.push(spy);
    // Re-render so component captures the spy
    await act(async () => {
      root.render(<MobileSidebar onOpenSettings={onOpenSettings} />);
    });
    const allTasksBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("All Tasks"),
    );
    await act(async () => {
      allTasksBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(spy).toHaveBeenCalledWith(null);
  });

  it("clicking a project calls setSelectedProject with project id", async () => {
    const spy = spyOn(useTaskStore.getState(), "setSelectedProject");
    spies.push(spy);
    const alphaBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Project Alpha"),
    );
    await act(async () => {
      alphaBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(spy).toHaveBeenCalledWith(projectAlpha.id);
  });

  it("clicking Jira Settings calls onOpenSettings", async () => {
    const settingsBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Jira Settings"),
    );
    await act(async () => {
      settingsBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("does not render org section when it has no visible projects", async () => {
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useTaskStore.setState({ tasks: [] } as any); // No tasks = no visible projects
      root.render(<MobileSidebar onOpenSettings={onOpenSettings} />);
    });
    expect(container.textContent).not.toContain("Project Alpha");
    expect(container.textContent).not.toContain("Acme");
  });
});
