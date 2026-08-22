import "@/test/jsdom-setup";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { CreatedTicketTable } from "@/components/CreatedTicketTable";
import type { Task } from "@/types/jira";

const openExternalMock = mock();

mock.module("@/lib/desktop", () => ({
  openExternal: (...args: unknown[]) => openExternalMock(...args),
}));

const task: Task = {
  id: "task-account-1-ALPHA-1",
  projectId: "proj-account-1-ALPHA",
  jiraTaskId: "ALPHA-1",
  title: "Track deployment request",
  description: null,
  status: "In Progress",
  statusCategory: "indeterminate",
  type: "Task",
  severity: "Medium",
  storyLevel: null,
  mandays: null,
  assignee: "Bob",
  isCurrentAssignee: false,
  isCreatedByCurrentUser: true,
  refUrl: "https://acme.atlassian.net/browse/ALPHA-1",
  note: null,
  isSynced: true,
  isDirty: false,
  createdAt: "2026-03-20T10:00:00.000Z",
  updatedAt: "2026-03-21T10:00:00.000Z",
};

describe("CreatedTicketTable", () => {
  afterEach(() => {
    openExternalMock.mockReset();
    document.body.innerHTML = "";
  });

  it("renders creator tickets as a read-only status view", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<CreatedTicketTable tasks={[task]} />);
    });

    expect(container.textContent).toContain("ALPHA-1");
    expect(container.textContent).toContain("Track deployment request");
    expect(container.textContent).toContain("Bob");
    expect(container.textContent).toContain("In Progress");
    expect(container.querySelector("[role='combobox']")).toBeNull();

    await act(async () => {
      container
        .querySelector("button[aria-label='Open ALPHA-1 in Jira']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(openExternalMock).toHaveBeenCalledWith(task.refUrl);

    await act(async () => {
      root.unmount();
    });
  });
});
