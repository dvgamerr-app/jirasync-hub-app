import { describe, expect, it } from "vitest";
import {
  isPendingDeleteWorkLog,
  isPendingCreateWorkLog,
  isVisibleWorkLog,
  toSyncedWorkLog,
} from "@/lib/worklog-sync";
import type { WorkLog } from "@/types/jira";

function makeLog(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: "wl-1",
    taskId: "task-1",
    timeSpentMinutes: 60,
    logDate: "2026-03-21",
    comment: null,
    createdAt: "2026-03-21T08:00:00.000Z",
    jiraWorklogId: "jira-1",
    syncStatus: "synced",
    ...overrides,
  };
}

describe("isPendingDeleteWorkLog", () => {
  it("returns true when syncStatus is pending_delete", () => {
    expect(isPendingDeleteWorkLog(makeLog({ syncStatus: "pending_delete" }))).toBe(true);
  });

  it("returns false for synced", () => {
    expect(isPendingDeleteWorkLog(makeLog({ syncStatus: "synced" }))).toBe(false);
  });

  it("returns false for pending_create", () => {
    expect(isPendingDeleteWorkLog(makeLog({ syncStatus: "pending_create" }))).toBe(false);
  });

  it("returns false when syncStatus is null", () => {
    expect(isPendingDeleteWorkLog(makeLog({ syncStatus: null }))).toBe(false);
  });
});

describe("isPendingCreateWorkLog", () => {
  it("returns true when syncStatus is pending_create", () => {
    expect(isPendingCreateWorkLog(makeLog({ syncStatus: "pending_create" }))).toBe(true);
  });

  it("returns true when jiraWorklogId is null and syncStatus is not pending_delete", () => {
    expect(
      isPendingCreateWorkLog(makeLog({ jiraWorklogId: null, syncStatus: "synced" })),
    ).toBe(true);
  });

  it("returns true when jiraWorklogId is null and syncStatus is null", () => {
    expect(
      isPendingCreateWorkLog(makeLog({ jiraWorklogId: null, syncStatus: null })),
    ).toBe(true);
  });

  it("returns false when jiraWorklogId is null but syncStatus is pending_delete", () => {
    expect(
      isPendingCreateWorkLog(makeLog({ jiraWorklogId: null, syncStatus: "pending_delete" })),
    ).toBe(false);
  });

  it("returns false for a fully synced worklog with a jira id", () => {
    expect(isPendingCreateWorkLog(makeLog({ jiraWorklogId: "jira-1", syncStatus: "synced" }))).toBe(
      false,
    );
  });
});

describe("isVisibleWorkLog", () => {
  it("returns true for a synced worklog", () => {
    expect(isVisibleWorkLog(makeLog({ syncStatus: "synced" }))).toBe(true);
  });

  it("returns true for a pending_create worklog", () => {
    expect(isVisibleWorkLog(makeLog({ syncStatus: "pending_create" }))).toBe(true);
  });

  it("returns false for a pending_delete worklog", () => {
    expect(isVisibleWorkLog(makeLog({ syncStatus: "pending_delete" }))).toBe(false);
  });
});

describe("toSyncedWorkLog", () => {
  it("sets jiraWorklogId and syncStatus to synced", () => {
    const log = makeLog({ jiraWorklogId: null, syncStatus: "pending_create" });
    const result = toSyncedWorkLog(log, "new-jira-id");

    expect(result.jiraWorklogId).toBe("new-jira-id");
    expect(result.syncStatus).toBe("synced");
  });

  it("preserves all other fields", () => {
    const log = makeLog({
      id: "wl-42",
      taskId: "task-99",
      timeSpentMinutes: 120,
      comment: "work done",
      jiraWorklogId: null,
      syncStatus: "pending_create",
    });
    const result = toSyncedWorkLog(log, "jira-42");

    expect(result.id).toBe("wl-42");
    expect(result.taskId).toBe("task-99");
    expect(result.timeSpentMinutes).toBe(120);
    expect(result.comment).toBe("work done");
  });

  it("does not mutate the original worklog", () => {
    const log = makeLog({ jiraWorklogId: null, syncStatus: "pending_create" });
    toSyncedWorkLog(log, "jira-new");

    expect(log.jiraWorklogId).toBeNull();
    expect(log.syncStatus).toBe("pending_create");
  });
});
