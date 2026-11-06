import { describe, expect, it } from "bun:test";
import type { RunEvent, RunEventKind, RunRecord, RunStatus } from "./harness";
import {
  agentIsThinking,
  buildConversation,
  currentActivity,
  runPhases,
  shortPath,
  summarizeTools,
} from "./run-conversation";

const journal = (...kinds: RunEventKind[]): RunEvent[] =>
  kinds.map((kind, index) => ({ runId: "r1", seq: index + 1, at: 0, ...kind }) as RunEvent);

const run = (status: RunStatus, mode = "agent"): RunRecord =>
  ({ runId: "r1", status, mode }) as RunRecord;

describe("buildConversation", () => {
  it("reads as owner and agent messages with tool calls and commands folded", () => {
    const items = buildConversation(
      journal(
        { type: "agent", kind: "owner", text: "Keep the Thai format" },
        { type: "step_start", step: "install", command: "bun install" },
        { type: "output", step: "install", stream: "stdout", text: "3 packages" },
        { type: "step_end", step: "install", exitCode: 0, durationMs: 1200 },
        { type: "agent", kind: "tool", text: "Read src/a.ts" },
        { type: "agent", kind: "tool", text: "Grep formatDate" },
        { type: "agent", kind: "text", text: "Plan is ready." },
        { type: "agent", kind: "init", text: "session" },
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["owner", "command", "tools", "agent"]);
    expect(items[1]).toMatchObject({ exitCode: 0, done: true, lines: [{ text: "3 packages" }] });
    expect(items[2]).toMatchObject({ tools: ["Read src/a.ts", "Grep formatDate"] });
  });

  it("a text message between tool calls starts a new tool row; only denials and failures are notices", () => {
    const items = buildConversation(
      journal(
        { type: "agent", kind: "tool", text: "Read a" },
        { type: "agent", kind: "text", text: "Found it" },
        { type: "agent", kind: "tool", text: "Read b" },
        { type: "permission", tool: "Bash", decision: "allow" },
        { type: "permission", tool: "Shell rm", decision: "deny" },
        { type: "status", status: "running", message: null },
        { type: "status", status: "failed", message: "install failed (exit code 1)" },
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["tools", "agent", "tools", "notice", "notice"]);
    expect(items.slice(3).map((item) => (item.kind === "notice" ? item.text : ""))).toEqual([
      "Blocked Shell rm",
      "install failed (exit code 1)",
    ]);
  });
});

describe("buildConversation: setup repairs", () => {
  it("shows that the agent is fixing a failed command and what it changed", () => {
    const items = buildConversation(
      journal(
        { type: "agent", kind: "notice", text: "install failed; the agent is fixing it" },
        { type: "agent", kind: "command_set", text: "install: bun install --cwd be" },
        { type: "agent", kind: "result", text: "success" },
      ),
    );
    expect(items.map((item) => (item.kind === "notice" ? item.text : item.kind))).toEqual([
      "install failed; the agent is fixing it",
      "Fixed the install command: bun install --cwd be",
    ]);
  });
});

describe("buildConversation: agent sessions", () => {
  it("groups what one agent session did under a turn named after its phase", () => {
    const items = buildConversation(
      journal(
        { type: "status", status: "reviewing", message: null },
        { type: "step_start", step: "agent", command: "claude -p You are an independent reviewer" },
        { type: "agent", kind: "tool", text: "Read C:\\wt\\run1\\src\\a.ts" },
        { type: "agent", kind: "text", text: "Checking the submodule" },
        { type: "step_start", step: "agent:test#1", command: "bun test" },
        { type: "step_end", step: "agent:test#1", exitCode: 0, durationMs: 10 },
        { type: "step_end", step: "agent", exitCode: 0, durationMs: 57_300 },
        { type: "agent", kind: "owner", text: "Accepted the change" },
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["turn", "owner"]);
    const turn = items[0];
    if (turn.kind !== "turn") throw new Error("not a turn");
    expect(turn).toMatchObject({ label: "Reviewing the change", done: true, failed: false });
    expect(turn.entries.map((entry) => entry.kind)).toEqual(["tools", "agent", "command"]);
    expect(JSON.stringify(items)).not.toContain("claude -p");
  });

  it("names a repair session after the command it fixes, and marks a failed session", () => {
    const items = buildConversation(
      journal(
        { type: "agent", kind: "notice", text: "install failed; the agent is fixing it" },
        { type: "step_start", step: "agent", command: "claude" },
        { type: "step_end", step: "agent", exitCode: 1, durationMs: 5 },
      ),
    );
    expect(items[1]).toMatchObject({ kind: "turn", label: "Fixing install", failed: true });
  });
});

describe("summarizeTools / shortPath", () => {
  it("summarizes a group of tool calls by what they did", () => {
    expect(
      summarizeTools([
        "Read a.ts",
        "Read b.ts",
        "Grep formatDate",
        "Edit a.ts",
        "run test",
        "run test",
        "skill_get harness",
      ]),
    ).toBe("Read 2 files · searched 1× · edited 1 file · ran test · loaded the harness skill");
    expect(summarizeTools(["submit_plan", "get_log verify:test", "TodoWrite"])).toBe(
      "Submitted plan · 2 other steps",
    );
  });

  it("shows worktree paths relative to the worktree and leaves others alone", () => {
    expect(shortPath("C:\\wt\\run1\\src\\a.ts", "C:\\wt\\run1")).toBe("src/a.ts");
    expect(shortPath("D:\\other\\a.ts", "C:\\wt\\run1")).toBe("D:\\other\\a.ts");
    expect(shortPath("formatDate", null)).toBe("formatDate");
  });
});

describe("runPhases", () => {
  it("marks earlier phases done and the current one active or waiting", () => {
    const states = runPhases(run("awaiting_plan"), []).map((phase) => phase.state);
    expect(states).toEqual(["done", "done", "waiting", "pending", "pending", "pending", "pending"]);
    expect(runPhases(run("running"), [])[3].state).toBe("active");
  });

  it("a failed run marks the phase it stopped in, not the first one", () => {
    const events = journal(
      { type: "status", status: "preparing", message: null },
      { type: "status", status: "installing", message: null },
      { type: "status", status: "failed", message: "install failed" },
    );
    const states = runPhases(run("failed"), events).map((phase) => phase.state);
    expect(states.slice(0, 3)).toEqual(["done", "failed", "pending"]);
  });

  it("a prepare-only run has only the workspace phases", () => {
    expect(runPhases(run("prepared", "prepare"), []).map((phase) => phase.state)).toEqual([
      "done",
      "done",
    ]);
  });
});

describe("currentActivity / agentIsThinking", () => {
  it("names the latest tool or command while busy, and nothing while waiting", () => {
    const events = journal({ type: "agent", kind: "tool", text: "Read src/a.ts" });
    expect(currentActivity(run("planning"), events)).toBe("Read src/a.ts");
    expect(
      currentActivity(
        run("verifying"),
        journal({ type: "step_start", step: "verify:test", command: "bun test" }),
      ),
    ).toBe("Running verify:test: bun test");
    expect(currentActivity(run("installing"), [])).toBe("Installing dependencies");
    expect(currentActivity(run("awaiting_plan"), events)).toBeNull();
  });

  it("shows typing only while the agent thinks and has not just answered", () => {
    expect(agentIsThinking(run("planning"), [])).toBe(true);
    expect(
      agentIsThinking(run("planning"), journal({ type: "agent", kind: "text", text: "Done" })),
    ).toBe(false);
    expect(agentIsThinking(run("installing"), [])).toBe(false);
  });
});
