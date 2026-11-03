import { describe, expect, it } from "bun:test";
import { buildSnapshot, parseSnapshot, planImport } from "@/lib/snapshot";
import type { AiBoardTaskState } from "@/lib/ai-board";
import type { JiraAccount } from "@/lib/jira-db";
import type { Task } from "@/types/jira";

const home: JiraAccount = {
  id: "home1",
  name: "Acme",
  instanceUrl: "https://acme.atlassian.net",
  email: "me@acme.test",
  apiToken: "secret-token-123",
};
// The same Jira account set up on another machine gets another local id.
const laptop: JiraAccount = {
  ...home,
  id: "lap9",
  instanceUrl: "acme.atlassian.net/",
  email: "ME@acme.test",
};

function task(accountId: string, key: string, note: string | null = null): Task {
  return {
    id: `task-${accountId}-${key}`,
    projectId: `proj-${accountId}-APP`,
    jiraTaskId: key,
    title: key,
    description: null,
    status: "To Do",
    type: "Task",
    severity: null,
    storyLevel: null,
    mandays: null,
    assignee: null,
    refUrl: null,
    note,
    isDirty: false,
    isSynced: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function aiState(
  accountId: string,
  key: string,
  status: AiBoardTaskState["status"],
  updatedAt: string,
): AiBoardTaskState {
  return { id: `task-${accountId}-${key}`, accountId, status, jiraDone: false, updatedAt };
}

describe("snapshot export", () => {
  it("never contains credentials and leaves notes out unless asked", () => {
    const snapshot = buildSnapshot(
      [home],
      [aiState("home1", "APP-1", "review", "2026-11-02T00:00:00Z")],
      [task("home1", "APP-1", "private note")],
      { includeNotes: false },
    );
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("secret-token-123");
    expect(text).not.toContain("private note");
    expect(text).not.toContain("home1");
    expect(snapshot.aiStates).toEqual([
      {
        account: "a1",
        issueKey: "APP-1",
        status: "review",
        jiraDone: false,
        updatedAt: "2026-11-02T00:00:00Z",
      },
    ]);
    const withNotes = buildSnapshot([home], [], [task("home1", "APP-1", "private note")], {
      includeNotes: true,
    });
    expect(withNotes.notes).toEqual([{ account: "a1", issueKey: "APP-1", note: "private note" }]);
  });

  it("round-trips onto the same Jira account under another local id", () => {
    const snapshot = parseSnapshot(
      JSON.stringify(
        buildSnapshot(
          [home],
          [aiState("home1", "APP-1", "doing", "2026-11-02T00:00:00Z")],
          [task("home1", "APP-1", "keep going")],
          { includeNotes: true },
        ),
      ),
    );
    const plan = planImport(snapshot, {
      accounts: [laptop],
      aiStates: [],
      tasks: [task("lap9", "APP-1")],
    });
    expect(plan.aiStates).toEqual([aiState("lap9", "APP-1", "doing", "2026-11-02T00:00:00Z")]);
    expect(plan.notes).toEqual([{ taskId: "task-lap9-APP-1", note: "keep going" }]);
    expect(plan.report.unknownAccounts).toEqual([]);
  });
});

describe("snapshot import conflicts", () => {
  const snapshot = buildSnapshot(
    [home],
    [
      aiState("home1", "APP-1", "done", "2026-11-02T00:00:00Z"),
      aiState("home1", "APP-2", "doing", "2026-11-01T00:00:00Z"),
    ],
    [task("home1", "APP-1", "theirs"), task("home1", "APP-3", "not synced here")],
    { includeNotes: true },
  );

  it("keeps the newer AI state and never overwrites a different local note", () => {
    const plan = planImport(snapshot, {
      accounts: [laptop],
      aiStates: [aiState("lap9", "APP-2", "review", "2026-11-03T00:00:00Z")],
      tasks: [task("lap9", "APP-1", "mine")],
    });
    expect(plan.aiStates.map((s) => [s.id, s.status])).toEqual([["task-lap9-APP-1", "done"]]);
    expect(plan.report.olderIgnored).toBe(1);
    expect(plan.notes).toEqual([]);
    expect(plan.report.noteConflicts).toEqual(["APP-1"]);
    expect(plan.report.missingTasks).toEqual(["APP-3"]);
  });

  it("does not match a different Jira site or person by issue key", () => {
    const other: JiraAccount = { ...laptop, instanceUrl: "https://other.atlassian.net" };
    const plan = planImport(snapshot, {
      accounts: [other],
      aiStates: [],
      tasks: [task("lap9", "APP-1")],
    });
    expect(plan.aiStates).toEqual([]);
    expect(plan.notes).toEqual([]);
    expect(plan.report.unknownAccounts).toEqual(["me@acme.test @ https://acme.atlassian.net"]);
  });

  it("rejects files it cannot read safely", () => {
    expect(() => parseSnapshot("not json")).toThrow("not JSON");
    expect(() => parseSnapshot(JSON.stringify({ format: "other" }))).toThrow(
      "not a JiraSync snapshot",
    );
    expect(() => parseSnapshot(JSON.stringify({ ...snapshot, version: 2 }))).toThrow("version 2");
    expect(() =>
      parseSnapshot(
        JSON.stringify({ ...snapshot, aiStates: [{ ...snapshot.aiStates[0], status: "hacked" }] }),
      ),
    ).toThrow("Unknown AI status");
    const bom = String.fromCharCode(0xfeff);
    expect(parseSnapshot(`${bom}${JSON.stringify(snapshot)}`).version).toBe(1);
  });
});
