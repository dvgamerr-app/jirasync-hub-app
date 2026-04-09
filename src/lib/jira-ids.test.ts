import { describe, expect, it } from "vitest";
import {
  getOrganizationId,
  getProjectId,
  getProjectIdPrefix,
  getTaskId,
  getTaskIdPrefix,
  getAccountIdFromTask,
  isOrganizationIdForAccounts,
  isProjectIdForAccounts,
  isTaskIdForAccounts,
} from "@/lib/jira-ids";
import type { Task } from "@/types/jira";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-account-1-ALPHA-1",
    projectId: "proj-account-1-ALPHA",
    jiraTaskId: "ALPHA-1",
    title: "T",
    description: null,
    status: "In Progress",
    type: "Task",
    severity: "Medium",
    storyLevel: 1,
    mandays: 1,
    assignee: null,
    refUrl: null,
    note: null,
    isSynced: true,
    isDirty: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getOrganizationId", () => {
  it("builds org id with correct prefix", () => {
    expect(getOrganizationId("account-1")).toBe("org-account-1");
  });
});

describe("getProjectId", () => {
  it("builds project id with account and project key", () => {
    expect(getProjectId("account-1", "ALPHA")).toBe("proj-account-1-ALPHA");
  });
});

describe("getProjectIdPrefix", () => {
  it("returns the prefix used by all projects for a given account", () => {
    expect(getProjectIdPrefix("account-1")).toBe("proj-account-1-");
  });
});

describe("getTaskId", () => {
  it("builds task id with account and issue key", () => {
    expect(getTaskId("account-1", "ALPHA-1")).toBe("task-account-1-ALPHA-1");
  });
});

describe("getTaskIdPrefix", () => {
  it("returns the prefix used by all tasks for a given account", () => {
    expect(getTaskIdPrefix("account-1")).toBe("task-account-1-");
  });
});

describe("getAccountIdFromTask", () => {
  it("extracts the account id from a well-formed task id", () => {
    const task = makeTask({ id: "task-account-1-ALPHA-1", jiraTaskId: "ALPHA-1" });
    expect(getAccountIdFromTask(task)).toBe("account-1");
  });

  it("works with a multi-segment issue key", () => {
    const task = makeTask({ id: "task-myorg-PROJ-42", jiraTaskId: "PROJ-42" });
    expect(getAccountIdFromTask(task)).toBe("myorg");
  });

  it("returns null when the task id does not start with task- prefix", () => {
    const task = makeTask({ id: "wrong-account-1-ALPHA-1", jiraTaskId: "ALPHA-1" });
    expect(getAccountIdFromTask(task)).toBeNull();
  });

  it("returns null when the task id does not end with the jira task id", () => {
    const task = makeTask({ id: "task-account-1-ALPHA-1", jiraTaskId: "BETA-1" });
    expect(getAccountIdFromTask(task)).toBeNull();
  });

  it("returns null when account segment would be empty", () => {
    const task = makeTask({ id: "task-ALPHA-1", jiraTaskId: "ALPHA-1" });
    expect(getAccountIdFromTask(task)).toBeNull();
  });
});

describe("isOrganizationIdForAccounts", () => {
  it("returns true when org id matches one of the accounts", () => {
    expect(isOrganizationIdForAccounts("org-account-1", ["account-1", "account-2"])).toBe(true);
  });

  it("returns false when org id matches none", () => {
    expect(isOrganizationIdForAccounts("org-account-3", ["account-1", "account-2"])).toBe(false);
  });
});

describe("isProjectIdForAccounts", () => {
  it("returns true for a project belonging to a listed account", () => {
    expect(isProjectIdForAccounts("proj-account-1-ALPHA", ["account-1"])).toBe(true);
  });

  it("returns false for a project from a different account", () => {
    expect(isProjectIdForAccounts("proj-account-2-ALPHA", ["account-1"])).toBe(false);
  });
});

describe("isTaskIdForAccounts", () => {
  it("returns true for a task belonging to a listed account", () => {
    expect(isTaskIdForAccounts("task-account-1-ALPHA-1", ["account-1"])).toBe(true);
  });

  it("returns false for a task from a different account", () => {
    expect(isTaskIdForAccounts("task-account-2-ALPHA-1", ["account-1"])).toBe(false);
  });

  it("returns false for empty account list", () => {
    expect(isTaskIdForAccounts("task-account-1-ALPHA-1", [])).toBe(false);
  });
});
