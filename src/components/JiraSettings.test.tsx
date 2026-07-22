import "@/test/jsdom-setup";
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, mock, jest } from "bun:test";
import { JiraSettingsDialog } from "@/components/JiraSettings";

// Function declarations are hoisted - available when mock.module factory runs
function createDbMocks() {
  const accounts = [
    {
      id: "acc-1",
      name: "Alpha",
      instanceUrl: "https://alpha.atlassian.net",
      email: "alpha@example.com",
      apiToken: "token-alpha",
    },
    {
      id: "acc-2",
      name: "Beta",
      instanceUrl: "https://beta.atlassian.net",
      email: "beta@example.com",
      apiToken: "token-beta",
    },
  ];

  return {
    getJiraAccounts: mock(() => accounts),
    addJiraAccount: mock(),
    updateJiraAccount: mock(),
    reorderJiraAccounts: mock(() => [accounts[1], accounts[0]]),
    removeJiraAccount: mock(),
    getStoryPointFieldMap: mock(() => ({})),
    saveStoryPointFieldMap: mock(),
    db: {
      projects: {
        where: mock(() => ({
          equals: mock(() => ({
            sortBy: mock(async () => []),
          })),
        })),
      },
    },
  };
}

// var stays available after vi.mock hoisting in the Vitest compatibility layer.
var dbMocks: ReturnType<typeof createDbMocks>;

mock.module("@/lib/jira-db", () => {
  dbMocks = createDbMocks();
  return dbMocks;
});

mock.module("@/lib/jira-api", () => ({
  testJiraConnection: mock(async () => true),
  fetchJiraFields: mock(async () => []),
  detectStoryPointCandidates: mock(async () => []),
}));

mock.module("@/lib/sync-service", () => ({
  startBackgroundSync: mock(),
  stopBackgroundSync: mock(),
}));

mock.module("@/lib/desktop", () => ({
  openExternal: mock(),
}));

mock.module("@/hooks/use-toast", () => ({
  toast: mock(),
}));

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));

mock.module("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  SelectValue: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

function getAccountRow(container: HTMLElement, label: string): HTMLDivElement | null {
  return container.querySelector(`button[aria-label="${label}"]`)?.closest("div") ?? null;
}

describe("JiraSettingsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<JiraSettingsDialog open onOpenChange={() => {}} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it("reorders Jira connections by dragging the handle over another row", async () => {
    const firstRow = getAccountRow(container, "Reorder Alpha");
    const secondRow = getAccountRow(container, "Reorder Beta");
    const handle = container.querySelector('button[aria-label="Reorder Alpha"]');

    expect(firstRow?.textContent).toContain("Alpha");
    expect(secondRow?.textContent).toContain("Beta");
    expect(handle).not.toBeNull();

    await act(async () => {
      handle?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    await act(async () => {
      secondRow?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });

    expect(dbMocks.reorderJiraAccounts).toHaveBeenCalledWith("acc-1", "acc-2");

    const reorderedRows = Array.from(container.querySelectorAll('button[aria-label^="Reorder "]'))
      .map((button) => button.closest("div"))
      .filter((row): row is HTMLDivElement => row !== null);
    expect(reorderedRows[0]?.textContent).toContain("Beta");
    expect(reorderedRows[1]?.textContent).toContain("Alpha");
  });
});
