import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "@/components/ExportDialog";
import type { Project, Task, WorkLog } from "@/types/jira";

const saveMock = vi.fn();
const writeTextFileMock = vi.fn();
const toastMock = vi.fn();
const fetchJiraMyselfDisplayNameMock = vi.fn();
const getJiraAccountsMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => writeTextFileMock(...args),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock("@/lib/jira-api", () => ({
  fetchJiraMyselfDisplayName: (...args: unknown[]) => fetchJiraMyselfDisplayNameMock(...args),
}));

vi.mock("@/lib/jira-db", () => ({
  getJiraAccounts: () => getJiraAccountsMock(),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  title: "Task Alpha",
  description: null,
  status: "In Progress",
  type: "Task",
  severity: "Medium",
  storyLevel: 2,
  mandays: 1,
  assignee: "Alice",
  refUrl: "https://acme.atlassian.net/browse/ALPHA-1",
  note: "Keep note",
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
    logDate: "2026-01-10",
    comment: null,
    createdAt: "2026-01-10T08:00:00.000Z",
    jiraWorklogId: "1",
  },
  {
    id: "wl-2",
    taskId: task.id,
    timeSpentMinutes: 120,
    logDate: "2026-03-21",
    comment: "Finish work",
    createdAt: "2026-03-21T08:00:00.000Z",
    jiraWorklogId: "2",
  },
];

describe("ExportDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onOpenChange: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenChange = vi.fn();

    saveMock.mockResolvedValue("C:\\exports\\jirasync-export-2026-Mar.csv");
    writeTextFileMock.mockResolvedValue(undefined);
    fetchJiraMyselfDisplayNameMock.mockResolvedValue("Alice");
    getJiraAccountsMock.mockReturnValue([
      {
        id: "account-1",
        name: "Acme",
        instanceUrl: "https://acme.atlassian.net",
        email: "alice@acme.test",
        apiToken: "token",
      },
    ]);

    await act(async () => {
      root.render(
        <ExportDialog
          open
          onOpenChange={onOpenChange}
          projects={[project]}
          tasks={[task]}
          workLogs={workLogs}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("lists time-tracking months in descending year-month order", () => {
    const content = container.textContent ?? "";

    expect(content).toContain("2026-Mar");
    expect(content).toContain("2026-Jan");
    expect(content.indexOf("2026-Mar")).toBeLessThan(content.indexOf("2026-Jan"));
  });

  it("exports the latest available month by default and does not auto-close the dialog", async () => {
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save CSV"),
    );

    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "jirasync-export-2026-Mar.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    expect(writeTextFileMock).toHaveBeenCalledWith(
      "C:\\exports\\jirasync-export-2026-Mar.csv",
      expect.stringContaining(
        "FullName,Project,Month,Year,Type,Story Point,Severity,Usage Time (min),Ref URL,Note",
      ),
    );
    expect(writeTextFileMock).toHaveBeenCalledWith(
      "C:\\exports\\jirasync-export-2026-Mar.csv",
      expect.stringContaining(
        "Alice,Project Alpha,Mar,2026,Task,2,Medium,120,https://acme.atlassian.net/browse/ALPHA-1,Keep note",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
