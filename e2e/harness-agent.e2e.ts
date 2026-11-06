import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, readE2EState } from "./helpers";
import { emptyRunRecord, readyDoctorReport, type E2EHarnessState } from "./shims/state";
import type { RepoBinding, RunEvent, RunEventKind, RunRecord } from "@/lib/harness";

const PROJECT_ID = "proj-acc1-PRJ";
const TASK_ID = "task-acc1-PRJ-1";

const binding: RepoBinding = {
  projectId: PROJECT_ID,
  repoPath: "C:/src/service",
  baseBranch: "main",
  worktreeRoot: "C:\\wt",
  commands: { test: { executable: "bun", args: ["test"] } },
  copyEnv: [],
  services: [],
  envOverrides: [],
  updatedAt: 1,
};

const worktree = {
  path: "C:\\wt\\agent01abc",
  branch: "ai/PRJ-1-agent01abc",
  baseSha: "0123456789abcdef",
  copiedEnv: [],
  missingEnv: [],
};

function agentRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ...emptyRunRecord(),
    runId: "agent01abc",
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    issueKey: "PRJ-1",
    repoPath: "C:/src/service",
    createdAt: 1,
    mode: "agent",
    sessionId: "11111111-2222-4333-8444-555555555555",
    worktree,
    ...overrides,
  };
}

async function seed(page: Page, harness: Partial<E2EHarnessState>) {
  await page.addInitScript(
    ([seedState, doctor]) => {
      window.__e2e = {
        files: {},
        opened: [],
        savePath: null,
        harness: { doctor, detections: {}, bindings: [], calls: [], ...seedState },
      };
    },
    [harness, readyDoctorReport()] as const,
  );
}

async function openTaskOnBoard(page: Page) {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", summary: "Board work" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await page.getByRole("button", { name: "PRJ-1: Board work" }).click();
  return page.getByRole("complementary", { name: "Board details PRJ-1" });
}

const openTab = (page: Page, name: "conversation" | "ticket" | "worktree log") =>
  page.getByRole("tab", { name }).click();
const chatBox = (page: Page) => page.getByRole("region", { name: "Agent chat" });

const push = (page: Page, event: RunEvent) =>
  page.evaluate((runEvent) => window.__e2ePushRunEvent!(runEvent), event);

const setRecord = (page: Page, changes: Partial<RunRecord>) =>
  page.evaluate((patch) => {
    const harness = window.__e2e!.harness!;
    harness.runs = harness.runs!.map((run) => ({ ...run, ...patch }));
  }, changes);

const calls = async (page: Page, cmd: string) =>
  ((await readE2EState(page)).harness?.calls ?? []).filter((call) => call.cmd === cmd);

const column = (page: Page, name: string) => page.getByRole("region", { name: `${name} column` });

test("Plan with Claude sends the task snapshot and waits for plan approval", async ({ page }) => {
  await seed(page, { bindings: [binding] });
  const panel = await openTaskOnBoard(page);
  await openTab(page, "ticket");
  await page.getByLabel("Board handoff").fill("private reminder for me");
  await page.getByLabel("Board handoff").blur();
  await openTab(page, "conversation");

  await chatBox(page).getByRole("button", { name: "Plan with Claude" }).click();
  const [start] = await calls(page, "harness_start_run");
  const context = String(start.args?.context);
  expect(context).toContain("PRJ-1");
  expect(context).toContain("Board work");
  expect(context, "the local note stays local unless opted in").not.toContain("private reminder");

  const runId = "run001abc";
  await push(page, { runId, seq: 2, at: 2, type: "status", status: "planning", message: null });
  await push(page, {
    runId,
    seq: 3,
    at: 3,
    type: "agent",
    kind: "tool",
    text: "skill_get harness",
  });
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Agent planning");
  // What the agent is doing shows live: the tool call, the typing bubble, the step it is in.
  await expect(panel.getByLabel("Agent activity")).toHaveText("Loaded skill harness");
  await expect(panel.getByLabel("Agent is thinking")).toBeVisible();
  await expect(
    panel.getByRole("list", { name: "Run steps" }).locator('[data-state="active"]'),
  ).toHaveText("Plan");
  await expect(panel).toContainText("Loaded the harness skill");
  await expect(
    column(page, "Doing").getByRole("button", { name: "PRJ-1: Board work" }),
  ).toBeVisible();

  await setRecord(page, { plan: "## Plan\n1. Edit src/sum.ts\n2. run test" });
  await push(page, {
    runId,
    seq: 4,
    at: 4,
    type: "status",
    status: "awaiting_plan",
    message: null,
  });
  await expect(panel.getByLabel("Agent plan")).toContainText("1. Edit src/sum.ts");
  await expect(chatBox(page).getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(chatBox(page).getByRole("button", { name: "Plan with Claude" })).toHaveCount(0);

  const revise = chatBox(page).getByRole("button", { name: "Revise plan" });
  await expect(revise, "revising needs written feedback").toBeDisabled();
  await chatBox(page).getByLabel("Feedback for the agent").fill("also handle negative numbers");
  await revise.click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args).toEqual({
    runId,
    decision: "revise_plan",
    feedback: "also handle negative numbers",
    context: null,
    provider: null,
  });
  // What the owner said stays in the conversation (journaled as seq 5), and the box is cleared.
  await expect(panel.getByLabel("Your message")).toHaveText("also handle negative numbers");
  await expect(chatBox(page).getByLabel("Feedback for the agent")).toHaveValue("");

  await setRecord(page, { status: "awaiting_plan" });
  await push(page, {
    runId,
    seq: 6,
    at: 6,
    type: "status",
    status: "awaiting_plan",
    message: null,
  });
  // Enter with an empty box approves; a written line would have revised instead.
  await chatBox(page).getByLabel("Feedback for the agent").press("Enter");
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(2);
  expect((await calls(page, "harness_resume_run"))[1].args?.decision).toBe("approve_plan");
});

test("the local note reaches the agent only when the owner opts in", async ({ page }) => {
  await seed(page, { bindings: [binding] });
  await openTaskOnBoard(page);
  await openTab(page, "ticket");
  await page.getByLabel("Board handoff").fill("use the v2 endpoint");
  await page.getByLabel("Board handoff").blur();
  await openTab(page, "conversation");
  await chatBox(page).getByLabel("Send my local note").check();
  await chatBox(page).getByRole("button", { name: "Plan with Claude" }).click();
  const [start] = await calls(page, "harness_start_run");
  expect(String(start.args?.context)).toContain("use the v2 endpoint");
});

test("review shows the app's own checks; Accept keeps the task in Review, not Done", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [
      agentRun({
        status: "ready_for_review",
        aiMs: 23_000,
        attempts: 1,
        checks: [
          { name: "test", status: "passed", exitCode: 0, logId: "verify:test", durationMs: 120 },
        ],
        changedFiles: ["src/sum.ts"],
        progress: "done: sum implemented\nnext: nothing",
      }),
    ],
    journal: { agent01abc: [] },
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Ready for review");
  await expect(panel.getByLabel("Checks")).toContainText("test passed");
  await expect(panel.getByLabel("Changed files")).toHaveText("Changed: src/sum.ts");
  await expect(panel.getByLabel("Agent progress")).toContainText("done: sum implemented");
  await openTab(page, "worktree log");
  await expect(panel).toContainText("Agent working time 23s · 1 repair round");
  await openTab(page, "conversation");

  const requestChanges = chatBox(page).getByRole("button", { name: "Request changes" });
  await expect(requestChanges).toBeDisabled();
  await chatBox(page).getByLabel("Feedback for the agent").fill("add a test for 0 + 0");
  await expect(requestChanges).toBeEnabled();
  await chatBox(page).getByLabel("Feedback for the agent").fill("");

  await chatBox(page).getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args?.decision).toBe("accept");
  await push(page, {
    runId: "agent01abc",
    seq: 2,
    at: 2,
    type: "status",
    status: "completed",
    message: null,
  });
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Accepted");
  // The PR is open: the task waits in Review, and its worktree stays for more work.
  await expect(
    column(page, "Review").getByRole("button", { name: "PRJ-1: Board work" }),
  ).toBeVisible();
  await expect(column(page, "Done").getByRole("button", { name: "PRJ-1: Board work" })).toHaveCount(
    0,
  );
  expect(await calls(page, "harness_remove_run_worktree")).toEqual([]);
});

test("planning again on a task with a worktree continues there, not in a new one", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "completed", prUrl: "https://github.com/acme/service/pull/42" })],
    journal: { agent01abc: [] },
  });
  await openTaskOnBoard(page);
  await expect(chatBox(page).getByLabel("Continues in worktree")).toHaveText(
    `↳ ${worktree.branch}`,
  );
  await chatBox(page).getByLabel("Feedback for the agent").fill("also handle zero");
  await chatBox(page).getByRole("button", { name: "Plan with Claude" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  const [resume] = await calls(page, "harness_resume_run");
  expect(resume.args).toMatchObject({
    runId: "agent01abc",
    decision: "continue",
    feedback: "also handle zero",
  });
  expect(String(resume.args?.context)).toContain("PRJ-1");
  expect(await calls(page, "harness_start_run")).toEqual([]);
});

test("a task whose worktree was removed starts a new one", async ({ page }) => {
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "completed", worktreeRemoved: true })],
    journal: { agent01abc: [] },
  });
  await openTaskOnBoard(page);
  await expect(chatBox(page).getByLabel("Continues in worktree")).toHaveCount(0);
  await chatBox(page).getByRole("button", { name: "Plan with Claude" }).click();
  await expect.poll(() => calls(page, "harness_start_run")).toHaveLength(1);
  expect(await calls(page, "harness_resume_run")).toEqual([]);
});

test("moving the card to AI Done removes its worktree; uncommitted work is kept", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "completed" })],
    journal: { agent01abc: [] },
  });
  await openTaskOnBoard(page);
  await openTab(page, "ticket");
  await page.getByLabel("AI task status").click();
  await page.getByRole("option", { name: "Done" }).click();
  await expect.poll(() => calls(page, "harness_remove_run_worktree")).toHaveLength(1);
  expect((await calls(page, "harness_remove_run_worktree"))[0].args).toEqual({
    runId: "agent01abc",
    discardChanges: false,
  });
});

test("a worktree with uncommitted work survives the move to Done, and the owner is told", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "completed" })],
    journal: { agent01abc: [] },
    dirtyWorktrees: ["agent01abc"],
  });
  await openTaskOnBoard(page);
  await openTab(page, "ticket");
  await page.getByLabel("AI task status").click();
  await page.getByRole("option", { name: "Done" }).click();
  await expect(
    page
      .getByLabel("Notifications (F8)")
      .getByText(/kept the worktree of PRJ-1 \(uncommitted changes\)/),
  ).toBeVisible();
  await expect(
    column(page, "Done").getByRole("button", { name: "PRJ-1: Board work" }),
  ).toBeVisible();
  const [removal] = await calls(page, "harness_remove_run_worktree");
  expect(removal.args?.discardChanges, "never discards on its own").toBe(false);
  const [run] = (await readE2EState(page)).harness?.runs ?? [];
  expect(run.worktreeRemoved).toBe(false);
});

test("a failed agent run can continue in its session with written instructions", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "failed", error: "checks still fail after 2 repair rounds: test" })],
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText(
    "Failed · checks still fail after 2 repair rounds: test",
  );
  const next = chatBox(page).getByRole("button", { name: "Continue with instructions" });
  await expect(next).toBeDisabled();
  await chatBox(page)
    .getByLabel("Feedback for the agent")
    .fill("the test needs bun 1.3; skip the snapshot");
  await next.click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args).toEqual({
    runId: "agent01abc",
    decision: "request_changes",
    feedback: "the test needs bun 1.3; skip the snapshot",
    context: null,
    provider: null,
  });
});

test("a failed prepare-only run offers no agent continuation", async ({ page }) => {
  await seed(page, {
    bindings: [binding],
    runs: [
      agentRun({
        mode: "prepare",
        sessionId: null,
        status: "failed",
        error: "install failed (exit code 1)",
      }),
    ],
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByRole("status", { name: "Run status" })).toContainText("install failed");
  await expect(
    chatBox(page).getByRole("button", { name: "Continue with instructions" }),
  ).toHaveCount(0);
  await expect(chatBox(page).getByRole("button", { name: "Plan with Claude" })).toBeEnabled();
});

test("Accept opens a Draft PR, and Ready for review unlocks only after CI passes", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [
      agentRun({
        status: "ready_for_review",
        checks: [
          { name: "test", status: "passed", exitCode: 0, logId: "verify:test", durationMs: 9 },
        ],
        changedFiles: ["src/sum.ts"],
      }),
    ],
    journal: { agent01abc: [] },
  });
  const panel = await openTaskOnBoard(page);
  await chatBox(page).getByRole("button", { name: "Accept & open Draft PR" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  await push(page, {
    runId: "agent01abc",
    seq: 2,
    at: 2,
    type: "status",
    status: "publishing",
    message: null,
  });
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText(
    "Committing, pushing and opening the Draft PR",
  );
  await expect(
    column(page, "Review").getByRole("button", { name: "PRJ-1: Board work" }),
  ).toBeVisible();

  const url = "https://github.com/acme/service/pull/42";
  await setRecord(page, { status: "completed", prUrl: url });
  await push(page, {
    runId: "agent01abc",
    seq: 3,
    at: 3,
    type: "status",
    status: "completed",
    message: null,
  });
  const pr = panel
    .getByRole("group", { name: "Pull request" })
    .or(panel.getByLabel("Pull request"));
  await expect(pr.getByRole("button", { name: "Draft pull request" })).toBeVisible();
  const ready = pr.getByRole("button", { name: "Ready for review" });
  await expect(ready, "nothing to judge before CI is checked").toBeDisabled();

  await page.evaluate(() => {
    window.__e2e!.harness!.ci = {
      checks: [
        { name: "build", bucket: "pass" },
        { name: "e2e", bucket: "pending" },
      ],
      allPassed: false,
    };
  });
  await pr.getByRole("button", { name: "Check CI" }).click();
  await expect(pr.getByLabel("CI checks")).toContainText("e2e running");
  await expect(ready).toBeDisabled();

  await page.evaluate(() => {
    window.__e2e!.harness!.ci = { checks: [{ name: "build", bucket: "pass" }], allPassed: true };
  });
  await pr.getByRole("button", { name: "Check CI" }).click();
  await expect(ready).toBeEnabled();
  await ready.click();
  await expect.poll(() => calls(page, "harness_mark_pr_ready")).toHaveLength(1);
  await expect(pr.getByRole("button", { name: "Pull request (ready for review)" })).toBeVisible();
  // Outside Tauri openExternal falls back to window.open; record it instead of opening a tab.
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (target) => {
      w.__opened.push(String(target));
      return null;
    };
  });
  await pr.getByRole("button", { name: "Pull request (ready for review)" }).click();
  expect(
    await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened),
  ).toContain(url);
});

test("a failed publish keeps the run reviewable and says why", async ({ page }) => {
  await seed(page, {
    bindings: [binding],
    runs: [
      agentRun({
        status: "ready_for_review",
        error:
          "a pull request for this branch was already merged: https://github.com/acme/service/pull/3",
      }),
    ],
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByRole("status", { name: "Run status" })).toContainText("already merged");
  await expect(chatBox(page).getByRole("button", { name: "Accept & open Draft PR" })).toBeEnabled();
  await expect(panel.getByLabel("Pull request")).toHaveCount(0);
});

test("the reviewer agent's concerns are shown and can become the owner's feedback", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [
      agentRun({
        status: "ready_for_review",
        checks: [
          { name: "test", status: "passed", exitCode: 0, logId: "verify:test", durationMs: 9 },
        ],
        review: {
          verdict: "concerns",
          summary: "negative numbers are not covered",
          findings: [{ file: "src/sum.test.ts", issue: "no test for negative inputs" }],
        },
      }),
    ],
  });
  const panel = await openTaskOnBoard(page);
  const review = panel.getByLabel("Independent review");
  await expect(review).toContainText("Reviewer agent: concerns · negative numbers are not covered");
  await expect(review).toContainText("src/sum.test.ts: no test for negative inputs");
  await expect(chatBox(page).getByRole("button", { name: "Accept & open Draft PR" })).toBeEnabled();

  await review.getByRole("button", { name: "Use findings as feedback" }).click();
  await expect(chatBox(page).getByLabel("Feedback for the agent")).toHaveValue(
    "- src/sum.test.ts: no test for negative inputs",
  );
  await chatBox(page).getByRole("button", { name: "Request changes" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args?.feedback).toBe(
    "- src/sum.test.ts: no test for negative inputs",
  );
});

test("an approving or missing review offers no findings to copy", async ({ page }) => {
  await seed(page, {
    bindings: [binding],
    runs: [
      agentRun({
        status: "ready_for_review",
        review: { verdict: "unavailable", summary: "the reviewer timed out", findings: [] },
      }),
    ],
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByLabel("Independent review")).toContainText(
    "Not reviewed · the reviewer timed out",
  );
  await expect(panel.getByRole("button", { name: "Use findings as feedback" })).toHaveCount(0);
});

test("Plan with Codex is offered when Doctor saw Codex start, and starts a Codex run", async ({
  page,
}) => {
  const doctor = readyDoctorReport();
  doctor.tools.push({
    name: "codex",
    required: false,
    purpose: "Coding agent (Codex CLI), instead of Claude",
    path: "C:/tools/codex.exe",
    version: "codex-cli 0.166.0",
    ok: true,
    detail: null,
  });
  await seed(page, { bindings: [binding], doctor });
  const panel = await openTaskOnBoard(page);
  await chatBox(page).getByRole("combobox", { name: "Coding agent provider" }).click();
  await page.getByRole("option", { name: "Codex" }).click();
  await chatBox(page).getByRole("button", { name: "Plan with Codex" }).click();
  await expect.poll(() => calls(page, "harness_start_run")).toHaveLength(1);
  const [start] = await calls(page, "harness_start_run");
  expect(start.args).toMatchObject({ issueKey: "PRJ-1", provider: "codex" });
  expect(String(start.args?.context)).toContain("PRJ-1");
  await openTab(page, "worktree log");
  await expect(panel.getByLabel("Coding agent")).toHaveText("Codex");
});

test("without a working Codex only Claude is offered, and Claude runs say so", async ({ page }) => {
  const doctor = readyDoctorReport();
  doctor.tools.push({
    name: "codex",
    required: false,
    purpose: "Coding agent (Codex CLI), instead of Claude",
    path: "C:/tools/codex.exe",
    version: null,
    ok: false,
    detail: "found but could not start: exit code 1",
  });
  await seed(page, { bindings: [binding], doctor });
  const panel = await openTaskOnBoard(page);
  await expect(chatBox(page).getByRole("button", { name: "Plan with Claude" })).toBeVisible();
  await expect(chatBox(page).getByRole("button", { name: "Plan with Codex" })).toHaveCount(0);
  await expect(chatBox(page).getByRole("combobox", { name: "Coding agent provider" })).toHaveCount(
    0,
  );
  await chatBox(page).getByRole("button", { name: "Plan with Claude" }).click();
  await expect.poll(() => calls(page, "harness_start_run")).toHaveLength(1);
  expect((await calls(page, "harness_start_run"))[0].args?.provider).toBe("claude");
  await openTab(page, "worktree log");
  await expect(panel.getByLabel("Coding agent")).toHaveText("Claude");
});

test("what the owner writes before planning goes to the agent and opens the conversation", async ({
  page,
}) => {
  await seed(page, { bindings: [binding] });
  const panel = await openTaskOnBoard(page);
  await chatBox(page).getByLabel("Feedback for the agent").fill("only touch the API layer");
  await chatBox(page).getByLabel("Feedback for the agent").press("Enter");
  await expect.poll(() => calls(page, "harness_start_run")).toHaveLength(1);
  const [start] = await calls(page, "harness_start_run");
  expect(start.args?.ownerMessage).toBe("only touch the API layer");
  expect(String(start.args?.context)).toContain(
    "## Instructions from the owner\n\nonly touch the API layer",
  );
  await expect(panel.getByLabel("Your message")).toHaveText("only touch the API layer");
  await expect(chatBox(page).getByLabel("Feedback for the agent")).toHaveValue("");
});

test("planning without a message sends only the ticket", async ({ page }) => {
  await seed(page, { bindings: [binding] });
  const panel = await openTaskOnBoard(page);
  await chatBox(page).getByRole("button", { name: "Plan with Claude" }).click();
  await expect.poll(() => calls(page, "harness_start_run")).toHaveLength(1);
  const [start] = await calls(page, "harness_start_run");
  expect(start.args?.ownerMessage).toBeNull();
  expect(String(start.args?.context)).not.toContain("Instructions from the owner");
  await expect(panel.getByLabel("Your message")).toHaveCount(0);
});

test("Enter never accepts a change: it only sends written feedback at review", async ({ page }) => {
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "ready_for_review" })],
    journal: { agent01abc: [] },
  });
  await openTaskOnBoard(page);
  const box = chatBox(page).getByLabel("Feedback for the agent");
  await box.press("Enter");
  await page.waitForTimeout(200);
  expect(await calls(page, "harness_resume_run")).toEqual([]);
  await box.fill("rename the helper");
  await box.press("Enter");
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args?.decision).toBe("request_changes");
});

test("an agent session shows as one turn: what it did, not the raw CLI command", async ({
  page,
}) => {
  const runId = "agent01abc";
  const ev = (seq: number, kind: RunEventKind) => ({ runId, seq, at: seq, ...kind }) as RunEvent;
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "reviewing" })],
    journal: {
      [runId]: [
        ev(1, { type: "status", status: "reviewing", message: null }),
        ev(2, {
          type: "step_start",
          step: "agent",
          command: "claude -p You are an independent reviewer",
        }),
        ev(3, { type: "agent", kind: "tool", text: `Read ${worktree.path}\\src\\sum.ts` }),
        ev(4, { type: "agent", kind: "tool", text: "Grep negative" }),
      ],
    },
  });
  const panel = await openTaskOnBoard(page);
  const turn = panel.getByRole("region", { name: "Claude: Reviewing the change" });
  await expect(turn).toHaveAttribute("data-active", "true");
  await expect(turn).toContainText("Read 1 file · searched 1×");
  await expect(turn).toContainText("src/sum.ts");
  await expect(turn.getByLabel("Agent activity")).toHaveText("Searched negative");
  await expect(panel).not.toContainText("claude -p");

  await push(page, {
    runId,
    seq: 5,
    at: 5,
    type: "step_end",
    step: "agent",
    exitCode: 0,
    durationMs: 57_300,
  });
  await expect(turn).not.toHaveAttribute("data-active", "true");
  await expect(turn).toContainText("57s");
  await expect(turn.getByLabel("Agent activity")).toHaveCount(0);
});

test("older long messages fold to a few lines; the newest stays open", async ({ page }) => {
  const runId = "agent01abc";
  const long = (label: string) =>
    Array.from({ length: 9 }, (_, index) => `${label} line ${index + 1}`).join("\n");
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "awaiting_plan", plan: "plan" })],
    journal: {
      [runId]: [
        { runId, seq: 1, at: 1, type: "agent", kind: "text", text: long("old") },
        { runId, seq: 2, at: 2, type: "agent", kind: "text", text: long("new") },
      ],
    },
  });
  const panel = await openTaskOnBoard(page);
  const [older, newer] = [
    panel.getByLabel("Agent message").first(),
    panel.getByLabel("Agent message").last(),
  ];
  await expect(newer.getByRole("button", { name: "Show more" })).toHaveCount(0);
  // Same length of text, but the older one is folded to a few lines.
  const box = await older.boundingBox();
  expect(box!.height).toBeLessThan((await newer.boundingBox())!.height / 1.5);
  await older.getByRole("button", { name: "Show more" }).click();
  expect((await older.boundingBox())!.height).toBeGreaterThan(box!.height);
  await expect(older.getByRole("button", { name: "Show less" })).toBeVisible();
});

test("a run that changed two repos lists one pull request per repo", async ({ page }) => {
  const be = "https://github.com/acme/service-be/pull/7";
  const fe = "https://github.com/acme/service-fe/pull/9";
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "completed", prUrl: be, prUrls: [be, fe] })],
    journal: { agent01abc: [] },
  });
  const panel = await openTaskOnBoard(page);
  const pr = panel.getByLabel("Pull request");
  await expect(pr.getByRole("button", { name: "Draft pull request · service-be" })).toBeVisible();
  await expect(pr.getByRole("button", { name: "Draft pull request · service-fe" })).toBeVisible();
});

test("a run with one pull request shows it without a repo name", async ({ page }) => {
  const url = "https://github.com/acme/service/pull/42";
  await seed(page, {
    bindings: [binding],
    runs: [agentRun({ status: "completed", prUrl: url })],
    journal: { agent01abc: [] },
  });
  const panel = await openTaskOnBoard(page);
  await expect(
    panel.getByRole("button", { name: "Draft pull request", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: /Draft pull request ·/ })).toHaveCount(0);
});
