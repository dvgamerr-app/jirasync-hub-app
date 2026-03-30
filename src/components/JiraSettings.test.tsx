import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraSettingsDialog } from "@/components/JiraSettings";

const dbMocks = vi.hoisted(() => {
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
    getJiraAccounts: vi.fn(() => accounts),
    addJiraAccount: vi.fn(),
    updateJiraAccount: vi.fn(),
    reorderJiraAccounts: vi.fn(() => [accounts[1], accounts[0]]),
    removeJiraAccount: vi.fn(),
    getStoryPointFieldMap: vi.fn(() => ({})),
    saveStoryPointFieldMap: vi.fn(),
    db: {
      projects: {
        where: vi.fn(() => ({
          equals: vi.fn(() => ({
            sortBy: vi.fn(async () => []),
          })),
        })),
      },
    },
  };
});

vi.mock("@/lib/jira-db", () => dbMocks);

vi.mock("@/lib/jira-api", () => ({
  testJiraConnection: vi.fn(async () => true),
  fetchJiraFields: vi.fn(async () => []),
  detectStoryPointCandidates: vi.fn(async () => []),
}));

vi.mock("@/lib/sync-service", () => ({
  startBackgroundSync: vi.fn(),
  stopBackgroundSync: vi.fn(),
}));

vi.mock("@/lib/desktop", () => ({
  openExternal: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));

vi.mock("@/components/ui/select", () => ({
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
    vi.clearAllMocks();
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
