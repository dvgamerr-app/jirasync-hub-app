import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSidebar } from "@/components/MobileSidebar";
import type { Organization, Project } from "@/types/jira";

const useTaskStoreMock = vi.fn();

vi.mock("@/store/task-store", () => ({
  useTaskStore: () => useTaskStoreMock(),
}));

vi.mock("@/components/ui/button", () => ({
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

vi.mock("@/components/ui/sheet", () => ({
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

vi.mock("@/components/ui/collapsible", () => ({
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

function buildStoreState(overrides: Partial<ReturnType<typeof defaultState>> = {}) {
  return { ...defaultState(), ...overrides };
}

function defaultState() {
  return {
    organizations: [org],
    selectedProjectId: null as string | null,
    setSelectedProject: vi.fn(),
    getVisibleProjects: () => [projectAlpha, projectBeta],
  };
}

describe("MobileSidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let storeState: ReturnType<typeof buildStoreState>;
  let onOpenSettings: () => void;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    storeState = buildStoreState();
    onOpenSettings = vi.fn<() => void>();
    useTaskStoreMock.mockImplementation(() => storeState);

    await act(async () => {
      root.render(<MobileSidebar onOpenSettings={onOpenSettings} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
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
    const allTasksBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("All Tasks"),
    );
    await act(async () => {
      allTasksBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(storeState.setSelectedProject).toHaveBeenCalledWith(null);
  });

  it("clicking a project calls setSelectedProject with project id", async () => {
    const alphaBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Project Alpha"),
    );
    await act(async () => {
      alphaBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(storeState.setSelectedProject).toHaveBeenCalledWith(projectAlpha.id);
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
    storeState = buildStoreState({ getVisibleProjects: () => [] });
    useTaskStoreMock.mockImplementation(() => storeState);
    await act(async () => {
      root.render(<MobileSidebar onOpenSettings={onOpenSettings} />);
    });
    expect(container.textContent).not.toContain("Project Alpha");
    expect(container.textContent).not.toContain("Acme");
  });
});
