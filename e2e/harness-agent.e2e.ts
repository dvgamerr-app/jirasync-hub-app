import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, readE2EState } from "./helpers";
import { emptyRunRecord, readyDoctorReport, type E2EHarnessState } from "./shims/state";
import type { RepoBinding, RunEvent, RunRecord } from "@/lib/harness";

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
  return page.getByRole("region", { name: "Agent run" });
}

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
  await page.getByLabel("Board handoff").fill("private reminder for me");
  await page.getByLabel("Board handoff").blur();

  await panel.getByRole("button", { name: "Plan with Claude" }).click();
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
  await expect(panel.getByLabel("Run log")).toContainText("→ skill_get harness");
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
  await expect(panel.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Plan with Claude" })).toHaveCount(0);

  const revise = panel.getByRole("button", { name: "Revise plan" });
  await expect(revise, "revising needs written feedback").toBeDisabled();
  await panel.getByLabel("Feedback for the agent").fill("also handle negative numbers");
  await revise.click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args).toEqual({
    runId,
    decision: "revise_plan",
    feedback: "also handle negative numbers",
  });

  await setRecord(page, { status: "awaiting_plan" });
  await push(page, {
    runId,
    seq: 5,
    at: 5,
    type: "status",
    status: "awaiting_plan",
    message: null,
  });
  await panel.getByRole("button", { name: "Approve plan" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(2);
  expect((await calls(page, "harness_resume_run"))[1].args?.decision).toBe("approve_plan");
});

test("the local note reaches the agent only when the owner opts in", async ({ page }) => {
  await seed(page, { bindings: [binding] });
  const panel = await openTaskOnBoard(page);
  await page.getByLabel("Board handoff").fill("use the v2 endpoint");
  await page.getByLabel("Board handoff").blur();
  await panel.getByLabel("Send my local note to the agent").check();
  await panel.getByRole("button", { name: "Plan with Claude" }).click();
  const [start] = await calls(page, "harness_start_run");
  expect(String(start.args?.context)).toContain("use the v2 endpoint");
});

test("review shows the app's own checks; Accept moves the task to Done", async ({ page }) => {
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
  await expect(panel).toContainText("Agent working time 23s · 1 repair round");

  const requestChanges = panel.getByRole("button", { name: "Request changes" });
  await expect(requestChanges).toBeDisabled();
  await panel.getByLabel("Feedback for the agent").fill("add a test for 0 + 0");
  await expect(requestChanges).toBeEnabled();
  await panel.getByLabel("Feedback for the agent").fill("");

  await panel.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args?.decision).toBe("accept");
  await push(page, {
    runId: "agent01abc",
    seq: 1,
    at: 1,
    type: "status",
    status: "completed",
    message: null,
  });
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Accepted");
  await expect(
    column(page, "Done").getByRole("button", { name: "PRJ-1: Board work" }),
  ).toBeVisible();
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
  const next = panel.getByRole("button", { name: "Continue with instructions" });
  await expect(next).toBeDisabled();
  await panel
    .getByLabel("Feedback for the agent")
    .fill("the test needs bun 1.3; skip the snapshot");
  await next.click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  expect((await calls(page, "harness_resume_run"))[0].args).toEqual({
    runId: "agent01abc",
    decision: "request_changes",
    feedback: "the test needs bun 1.3; skip the snapshot",
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
  await expect(panel.getByRole("button", { name: "Continue with instructions" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Plan with Claude" })).toBeEnabled();
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
  await panel.getByRole("button", { name: "Accept & open Draft PR" }).click();
  await expect.poll(() => calls(page, "harness_resume_run")).toHaveLength(1);
  await push(page, {
    runId: "agent01abc",
    seq: 1,
    at: 1,
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
    seq: 2,
    at: 2,
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
  await expect(panel.getByRole("button", { name: "Accept & open Draft PR" })).toBeEnabled();
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
  await expect(panel.getByRole("button", { name: "Accept & open Draft PR" })).toBeEnabled();

  await review.getByRole("button", { name: "Use findings as feedback" }).click();
  await expect(panel.getByLabel("Feedback for the agent")).toHaveValue(
    "- src/sum.test.ts: no test for negative inputs",
  );
  await panel.getByRole("button", { name: "Request changes" }).click();
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
