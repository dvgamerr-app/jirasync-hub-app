import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, readE2EState } from "./helpers";
import { readyDoctorReport, type E2EHarnessState } from "./shims/state";
import type { RepoBinding } from "@/lib/harness";

const binding: RepoBinding = {
  projectId: "proj-acc1-PRJ",
  repoPath: "C:/src/service",
  baseBranch: "main",
  worktreeRoot: "C:\\wt",
  commands: { test: { executable: "bun", args: ["test"] } },
  copyEnv: [],
  services: [],
  envOverrides: [],
  updatedAt: 1,
};

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

async function openBoard(page: Page) {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", summary: "Ready work" });
  jira.addIssue({ key: "PRJ-2", summary: "Other work" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  // The private note must never reach external agents.
  await page.evaluate(() => localStorage.setItem("jirasync-harness-setup-seen", "1"));
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await expect(page.getByTestId("ai-board")).toBeVisible();
}

async function turnOn(page: Page) {
  await page.getByRole("button", { name: "Agent setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Agent setup" });
  await dialog.getByRole("tab", { name: "external agents" }).click();
  await dialog.getByLabel("Allow for").selectOption("8");
  await dialog.getByRole("button", { name: "Turn on" }).click();
  await expect(dialog.getByRole("status")).toContainText("On until");
  return dialog;
}

const board = async (page: Page) => (await readE2EState(page)).harness?.board;
const calls = async (page: Page, cmd: string) =>
  ((await readE2EState(page)).harness?.calls ?? []).filter((call) => call.cmd === cmd);

test("turning on board access publishes only ready tasks and shows the client config", async ({
  page,
}) => {
  await seed(page, { bindings: [binding] });
  await openBoard(page);
  await page.getByRole("button", { name: "PRJ-2: Other work" }).click();
  await page.getByLabel("AI task status").click();
  await page.getByRole("option", { name: "Doing" }).click();
  await page.getByRole("button", { name: "PRJ-1: Ready work" }).click();
  await page.getByLabel("Board handoff").fill("private reminder for me");
  await page.getByLabel("Board handoff").blur();

  const dialog = await turnOn(page);
  expect((await calls(page, "harness_board_enable"))[0].args).toEqual({ hours: 8 });
  await expect(dialog.getByLabel("MCP config (keep the token private)")).toHaveValue(
    /127\.0\.0\.1/,
  );
  await expect
    .poll(async () => (await board(page))?.tasks.map((t) => t.issueKey))
    .toEqual(["PRJ-1"]);
  const [task] = (await board(page))!.tasks;
  expect(task.context).toContain("PRJ-1");
  expect(task.context).not.toContain("private reminder");

  // Moving the task out of To Do withdraws it from external agents.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "PRJ-1: Ready work" }).click();
  await page.getByLabel("AI task status").click();
  await page.getByRole("option", { name: "Doing" }).click();
  await expect.poll(async () => (await board(page))?.tasks.length).toBe(0);
});

test("nothing is published while board access is off, and turning it off stops publishing", async ({
  page,
}) => {
  await seed(page, { bindings: [binding] });
  await openBoard(page);
  await page.getByRole("button", { name: "PRJ-1: Ready work" }).click();
  await page.waitForTimeout(600);
  expect(await calls(page, "harness_board_publish")).toEqual([]);

  const dialog = await turnOn(page);
  await expect.poll(async () => (await calls(page, "harness_board_publish")).length).toBe(1);
  await dialog.getByRole("button", { name: "Turn off" }).click();
  await expect(dialog.getByRole("button", { name: "Turn on" })).toBeVisible();
  const published = (await calls(page, "harness_board_publish")).length;
  await page.keyboard.press("Escape");
  await page.getByLabel("AI task status").click();
  await page.getByRole("option", { name: "Doing" }).click();
  await page.waitForTimeout(600);
  expect((await calls(page, "harness_board_publish")).length).toBe(published);
});

test("an external request waits for the owner; approving starts the requested agent", async ({
  page,
}) => {
  await seed(page, { bindings: [binding] });
  await openBoard(page);
  await turnOn(page);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await board(page))?.tasks.length).toBe(2);

  await page.evaluate(() =>
    window.__e2eBoardRequest!("task-acc1-PRJ-1", "codex", "please add tests"),
  );
  // Radix also announces the toast in a live region, so the text can appear twice.
  await expect(page.getByText("An agent asked to run a task").first()).toBeVisible();
  expect(await calls(page, "harness_start_run")).toEqual([]);

  await page.getByRole("button", { name: "PRJ-1: Ready work" }).click();
  const request = page.getByLabel("Agent request");
  await expect(request).toContainText(
    "An external agent asked to run this task with Codex: please add tests",
  );
  await request.getByRole("button", { name: "Approve & plan" }).click();
  await expect.poll(async () => (await calls(page, "harness_start_run")).length).toBe(1);
  expect((await calls(page, "harness_start_run"))[0].args).toMatchObject({
    issueKey: "PRJ-1",
    provider: "codex",
  });
  await expect(request).toHaveCount(0);
  expect((await board(page))?.requests[0].status).toBe("approved");
});

test("declining an external request starts nothing", async ({ page }) => {
  await seed(page, { bindings: [binding] });
  await openBoard(page);
  await turnOn(page);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await board(page))?.tasks.length).toBe(2);
  await page.evaluate(() => window.__e2eBoardRequest!("task-acc1-PRJ-1", "claude"));

  await page.getByRole("button", { name: "PRJ-1: Ready work" }).click();
  await page.getByLabel("Agent request").getByRole("button", { name: "Decline" }).click();
  await expect(page.getByLabel("Agent request")).toHaveCount(0);
  expect((await board(page))?.requests[0].status).toBe("declined");
  expect(await calls(page, "harness_start_run")).toEqual([]);
});
