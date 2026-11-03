import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, readE2EState } from "./helpers";
import { readyDoctorReport, type E2EHarnessState } from "./shims/state";
import type { RepoBinding, RunEvent, RunRecord } from "@/lib/harness";

const PROJECT_ID = "proj-acc1-PRJ";
const TASK_ID = "task-acc1-PRJ-1";

const binding: RepoBinding = {
  projectId: PROJECT_ID,
  repoPath: "C:/src/service",
  baseBranch: "main",
  worktreeRoot: "C:\\wt",
  commands: { install: { executable: "bun", args: ["install", "--frozen-lockfile"] } },
  copyEnv: [".env"],
  updatedAt: 1,
};

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "seed01abc",
    taskId: TASK_ID,
    projectId: PROJECT_ID,
    issueKey: "PRJ-1",
    repoPath: "C:/src/service",
    status: "installing",
    worktree: null,
    worktreeRemoved: false,
    createdAt: 1,
    endedAt: null,
    error: null,
    ...overrides,
  };
}

const worktree = {
  path: "C:\\wt\\seed01abc",
  branch: "ai/PRJ-1-seed01abc",
  baseSha: "0123456789abcdef",
  copiedEnv: [".env"],
  missingEnv: [],
};

function output(
  runId: string,
  seq: number,
  text: string,
  stream: "stdout" | "stderr" = "stdout",
): RunEvent {
  return { runId, seq, at: seq, type: "output", step: "install", stream, text };
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
  jira.addIssue({ key: "PRJ-2", summary: "Other work" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await page.getByRole("button", { name: "PRJ-1: Board work" }).click();
  return page.getByRole("region", { name: "Agent run" });
}

const push = (page: Page, event: RunEvent) =>
  page.evaluate((runEvent) => window.__e2ePushRunEvent!(runEvent), event);

const calls = async (page: Page, cmd: string) =>
  ((await readE2EState(page)).harness?.calls ?? []).filter((call) => call.cmd === cmd);

test("a project without a repository explains what to do and starts nothing", async ({ page }) => {
  await seed(page, { bindings: [] });
  const panel = await openTaskOnBoard(page);
  await expect(panel).toContainText("This project has no repository yet");
  await expect(panel.getByRole("button", { name: "Prepare workspace" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Open Setup" }).click();
  await expect(page.getByRole("dialog", { name: "Agent setup" })).toBeVisible();
  expect(await calls(page, "harness_start_run")).toEqual([]);
});

test("preparing a workspace streams the app's output live and ends ready", async ({ page }) => {
  await seed(page, { bindings: [binding] });
  const panel = await openTaskOnBoard(page);
  await panel.getByRole("button", { name: "Prepare workspace" }).click();
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Creating worktree");
  const [start] = await calls(page, "harness_start_run");
  expect(start.args).toEqual({ taskId: TASK_ID, projectId: PROJECT_ID, issueKey: "PRJ-1" });

  const runId = "run001abc";
  await push(page, { runId, seq: 2, at: 2, type: "status", status: "installing", message: null });
  await push(page, {
    runId,
    seq: 3,
    at: 3,
    type: "step_start",
    step: "install",
    command: "bun install --frozen-lockfile",
  });
  await push(page, output(runId, 4, "installed 3 packages"));
  await push(page, output(runId, 4, "installed 3 packages"));
  await push(page, output(runId, 5, "warn: peer dependency", "stderr"));
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText(
    "Installing dependencies",
  );
  await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible();

  await page.evaluate((info) => {
    const harness = window.__e2e!.harness!;
    harness.runs = harness.runs!.map((run) => ({
      ...run,
      worktree: { ...info, path: "C:\\wt\\run001abc", branch: "ai/PRJ-1-run001abc" },
    }));
  }, worktree);
  await push(page, { runId, seq: 6, at: 6, type: "status", status: "prepared", message: null });

  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Workspace ready");
  const log = panel.getByLabel("Run log");
  await expect(log).toContainText("▶ install: bun install --frozen-lockfile");
  await expect(log.getByText("installed 3 packages")).toHaveCount(1);
  await expect(log).toContainText("warn: peer dependency");
  await expect(panel).toContainText("ai/PRJ-1-run001abc · C:\\wt\\run001abc");
  await expect(panel.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Prepare again" })).toBeEnabled();
});

test("Stop asks the native core to stop the run and the panel shows it stopped", async ({
  page,
}) => {
  await seed(page, { bindings: [binding], runs: [record()], journal: { seed01abc: [] } });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText(
    "Installing dependencies",
  );
  await expect(panel.getByRole("button", { name: "Prepare again" })).toHaveCount(0);

  await panel.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => calls(page, "harness_stop_run")).toHaveLength(1);
  expect((await calls(page, "harness_stop_run"))[0].args).toEqual({ runId: "seed01abc" });
  await push(page, {
    runId: "seed01abc",
    seq: 1,
    at: 1,
    type: "status",
    status: "cancelled",
    message: null,
  });
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText("Stopped");
  await expect(panel.getByRole("button", { name: "Prepare again" })).toBeEnabled();
});

test("only one run at a time: another active task blocks Prepare and says which", async ({
  page,
}) => {
  const other = record({ runId: "other1abc", taskId: "task-acc1-PRJ-2", issueKey: "PRJ-2" });
  await seed(page, { bindings: [binding], runs: [other] });
  const panel = await openTaskOnBoard(page);
  const prepare = panel.getByRole("button", { name: "Prepare workspace" });
  await expect(prepare).toBeDisabled();
  await expect(panel).toContainText("Another run (PRJ-2) is active");
  expect(await calls(page, "harness_start_run")).toEqual([]);
});

test("missed events are replayed from the journal once, in order", async ({ page }) => {
  const runId = "seed01abc";
  await seed(page, {
    bindings: [binding],
    runs: [record()],
    journal: { [runId]: [output(runId, 1, "line 1"), output(runId, 2, "line 2")] },
  });
  const panel = await openTaskOnBoard(page);
  const log = panel.getByLabel("Run log");
  await expect(log).toHaveText(/line 1\s*line 2/);

  // Lines 3 and 4 reached the journal while this window was not listening.
  await page.evaluate(
    (events) => {
      window.__e2e!.harness!.journal!.seed01abc.push(...events);
    },
    [output(runId, 3, "line 3"), output(runId, 4, "line 4")],
  );
  await push(page, output(runId, 5, "line 5"));

  await expect(log).toHaveText(/line 1\s*line 2\s*line 3\s*line 4\s*line 5$/);
  for (const line of ["line 3", "line 4", "line 5"])
    await expect(log.getByText(line)).toHaveCount(1);
});

test("a run interrupted by an app restart shows why and can be prepared again", async ({
  page,
}) => {
  await seed(page, {
    bindings: [binding],
    runs: [record({ status: "interrupted", error: "the app closed while this run was active" })],
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel.getByRole("status", { name: "Run status" })).toHaveText(
    "Interrupted · the app closed while this run was active",
  );
  await expect(panel.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Prepare again" })).toBeEnabled();
});

test("removing a worktree with uncommitted work needs an explicit discard", async ({ page }) => {
  await seed(page, {
    bindings: [binding],
    runs: [record({ status: "prepared", worktree })],
    dirtyWorktrees: ["seed01abc"],
  });
  const panel = await openTaskOnBoard(page);
  await expect(panel).toContainText(worktree.path);

  await panel.getByRole("button", { name: "Remove worktree" }).click();
  await expect(panel.getByRole("alert")).toContainText("uncommitted");
  await expect(panel).toContainText(worktree.path);
  expect((await calls(page, "harness_remove_run_worktree"))[0].args).toEqual({
    runId: "seed01abc",
    discardChanges: false,
  });

  await panel.getByRole("button", { name: "Discard changes and remove" }).click();
  await expect(panel).not.toContainText(worktree.path);
  expect((await calls(page, "harness_remove_run_worktree"))[1].args).toEqual({
    runId: "seed01abc",
    discardChanges: true,
  });
});
