import { describe, expect, it } from "bun:test";
import type { Task } from "@/types/jira";
import { buildAiContext } from "@/lib/ai-context";

const task: Task = {
  id: "task-account-a-APP-1",
  projectId: "proj-account-a-APP",
  jiraTaskId: "APP-1",
  title: "Fix API",
  description: "Keep Case",
  status: "In Progress",
  type: "Bug",
  severity: "High",
  storyLevel: null,
  mandays: null,
  assignee: null,
  refUrl: "https://example.atlassian.net/browse/APP-1",
  note: "Private handoff",
  isSynced: true,
  isDirty: false,
  createdAt: "2026-11-01",
  updatedAt: "2026-11-01",
};

describe("buildAiContext", () => {
  it("exports the ticket and instructions without the local note by default", () => {
    const context = buildAiContext(task);
    expect(context).toContain("APP-1: Fix API");
    expect(context).toContain("Keep Case");
    expect(context).toContain("ask before implementing");
    expect(context).not.toContain("Private handoff");
  });
  it("includes the local note only when selected", () => {
    expect(buildAiContext(task, { includeNote: true })).toContain("Private handoff");
  });
  it("includes a parent belonging to the same account", () => {
    const parent = {
      ...task,
      id: "task-account-a-APP-2",
      jiraTaskId: "APP-2",
      title: "Epic title",
    };
    expect(buildAiContext({ ...task, parentKey: "APP-2" }, { parent })).toContain(
      "APP-2: Epic title",
    );
  });
  it("does not include a matching parent key from another account", () => {
    const parent = {
      ...task,
      id: "task-account-b-APP-2",
      jiraTaskId: "APP-2",
      title: "Other account secret",
    };
    const context = buildAiContext({ ...task, parentKey: "APP-2" }, { parent });
    expect(context).not.toContain("Other account secret");
    expect(context).toContain("details unavailable offline");
  });
});
