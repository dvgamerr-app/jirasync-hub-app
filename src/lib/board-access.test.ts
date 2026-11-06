import { describe, expect, it } from "bun:test";
import { readyBoardTasks } from "@/lib/board-access";
import type { AiBoardTaskState } from "@/lib/ai-board";
import type { RepoBinding } from "@/lib/harness";
import type { Task } from "@/types/jira";

const base: Task = {
  id: "task-account-APP-1",
  projectId: "proj-account-APP",
  jiraTaskId: "APP-1",
  title: "Ready work",
  description: null,
  status: "To Do",
  statusCategory: "new",
  type: "Task",
  severity: null,
  storyLevel: null,
  mandays: null,
  assignee: null,
  refUrl: null,
  note: "private reminder",
  isDirty: false,
  isSynced: true,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const binding = { projectId: "proj-account-APP" } as RepoBinding;

function state(task: Task, status: AiBoardTaskState["status"]): AiBoardTaskState {
  return { id: task.id, accountId: "account", status, jiraDone: false, updatedAt: "2026-01-01" };
}

describe("readyBoardTasks", () => {
  it("shares To Do tasks of bound projects with their snapshot but never the note", () => {
    const [ready] = readyBoardTasks([base], [], [binding]);
    expect(ready).toMatchObject({ taskId: base.id, issueKey: "APP-1", title: "Ready work" });
    expect(ready.context).toContain("APP-1");
    expect(ready.context).not.toContain("private reminder");
  });

  it("hides tasks that are in progress, done in Jira, or in unbound projects", () => {
    const doing = { ...base, id: "task-account-APP-2", jiraTaskId: "APP-2" };
    const jiraDone = {
      ...base,
      id: "task-account-APP-3",
      jiraTaskId: "APP-3",
      status: "Done",
      statusCategory: "done",
    };
    const unbound = {
      ...base,
      id: "task-account-OPS-1",
      projectId: "proj-account-OPS",
      jiraTaskId: "OPS-1",
    };
    const ready = readyBoardTasks(
      [base, doing, jiraDone, unbound],
      [state(doing, "doing")],
      [binding],
    );
    expect(ready.map((task) => task.issueKey)).toEqual(["APP-1"]);
    expect(readyBoardTasks([base], [], [])).toEqual([]);
  });
});
