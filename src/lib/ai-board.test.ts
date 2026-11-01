import { describe, expect, it } from "bun:test";
import { getAiBoardStatus, isAiBoardCompletedByJira, type AiBoardTaskState } from "@/lib/ai-board";
import type { Task } from "@/types/jira";

const task: Task = {
  id: "task-account-APP-1",
  projectId: "proj-account-APP",
  jiraTaskId: "APP-1",
  title: "Work",
  description: null,
  status: "Custom QA",
  statusCategory: "indeterminate",
  type: "Task",
  severity: null,
  storyLevel: null,
  mandays: null,
  assignee: null,
  refUrl: null,
  note: null,
  isDirty: false,
  isSynced: true,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const state: AiBoardTaskState = {
  id: task.id,
  accountId: "account",
  status: "review",
  jiraDone: false,
  updatedAt: "2026-01-01",
};

describe("AI board completion boundaries", () => {
  it("recognizes custom completed Jira statuses by category", () => {
    expect(getAiBoardStatus({ ...task, status: "Released", statusCategory: "done" }, state)).toBe(
      "done",
    );
    expect(getAiBoardStatus(task, state)).toBe("review");
  });
  it("keeps authoritative Jira completion when local Jira edits show an older status", () => {
    const local = { ...task, status: "To Do", isDirty: true, dirtyFields: ["status" as const] };
    expect(getAiBoardStatus(local, { ...state, jiraDone: true })).toBe("done");
    expect(isAiBoardCompletedByJira(local, { ...state, jiraDone: true })).toBe(true);
    expect(getAiBoardStatus(local, state)).toBe("review");
  });
  it("ignores state from another account or invalid stored statuses", () => {
    expect(getAiBoardStatus(task, { ...state, id: "task-account-APP-2", jiraDone: true })).toBe(
      "todo",
    );
    expect(getAiBoardStatus(task, { ...state, accountId: "other", jiraDone: true })).toBe("todo");
    expect(
      getAiBoardStatus(task, { ...state, status: "invalid" as AiBoardTaskState["status"] }),
    ).toBe("todo");
    expect(getAiBoardStatus(task)).toBe("todo");
  });
});
