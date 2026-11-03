import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, readE2EState } from "./helpers";
import { readyDoctorReport, type E2EHarnessState } from "./shims/state";

async function seed(page: Page, harness: Partial<E2EHarnessState>, savePath: string | null = null) {
  await page.addInitScript(
    ([seedState, doctor, path]) => {
      window.__e2e = {
        files: {},
        opened: [],
        savePath: path,
        harness: { doctor, detections: {}, bindings: [], calls: [], ...seedState },
      };
      localStorage.setItem("jirasync-harness-setup-seen", "1");
    },
    [harness, readyDoctorReport(), savePath] as const,
  );
}

async function openSync(page: Page) {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", summary: "Board work" });
  jira.addIssue({ key: "PRJ-2", summary: "Other work" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  return jira;
}

async function moveTo(page: Page, card: string, column: string) {
  await page.getByRole("button", { name: card }).click();
  await page.getByLabel("AI task status").click();
  await page.getByRole("option", { name: column }).click();
}

async function syncTab(page: Page) {
  await page.getByRole("button", { name: "Agent setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Agent setup" });
  await dialog.getByRole("tab", { name: "sync" }).click();
  return dialog;
}

/** A snapshot as another machine (same Jira site and email, another local id) wrote it. */
function remoteSnapshot(jiraUrl: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: "jirasync-snapshot",
    version: 1,
    exportedAt: "2026-11-03T00:00:00Z",
    accounts: [{ ref: "a1", instanceUrl: jiraUrl, email: "me@acme.test" }],
    aiStates: [
      {
        account: "a1",
        issueKey: "PRJ-2",
        status: "review",
        jiraDone: false,
        updatedAt: "2099-01-01T00:00:00Z",
      },
    ],
    notes: [{ account: "a1", issueKey: "PRJ-2", note: "from the other machine" }],
    ...overrides,
  });
}

test("export writes AI progress without tokens, and notes only when asked", async ({ page }) => {
  await seed(page, {}, "C:/e2e/jirasync-snapshot.json");
  await openSync(page);
  await moveTo(page, "PRJ-1: Board work", "Doing");
  await page.getByLabel("Board handoff").fill("my private note");
  await page.getByLabel("Board handoff").blur();
  const dialog = await syncTab(page);

  await dialog.getByRole("button", { name: "Export file" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Saved C:/e2e/jirasync-snapshot.json");
  let file = (await readE2EState(page)).files["C:/e2e/jirasync-snapshot.json"];
  const snapshot = JSON.parse(file);
  expect(snapshot.aiStates).toEqual([
    expect.objectContaining({ account: "a1", issueKey: "PRJ-1", status: "doing" }),
  ]);
  expect(file).not.toContain("test-token");
  expect(file).not.toContain("my private note");

  await dialog.getByLabel("Include my local notes").check();
  await dialog.getByRole("button", { name: "Export file" }).click();
  await expect
    .poll(async () => (await readE2EState(page)).files["C:/e2e/jirasync-snapshot.json"])
    .toContain("my private note");
  file = (await readE2EState(page)).files["C:/e2e/jirasync-snapshot.json"];
  expect(file).not.toContain("test-token");
});

test("import merges another machine's progress onto the same Jira account", async ({ page }) => {
  await seed(page, {});
  const jira = await openSync(page);
  const dialog = await syncTab(page);
  await dialog.getByLabel("Import snapshot file").setInputFiles({
    name: "jirasync-snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(remoteSnapshot(jira.baseUrl)),
  });
  await expect(dialog.getByRole("status")).toHaveText("Imported 1 AI status · 1 note.");
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("region", { name: "Review column" })
      .getByRole("button", { name: "PRJ-2: Other work" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "PRJ-2: Other work" }).click();
  await expect(page.getByLabel("Board handoff")).toHaveValue("from the other machine");
});

test("import never overwrites a different local note, and rejects unreadable files", async ({
  page,
}) => {
  await seed(page, {});
  const jira = await openSync(page);
  await page.getByRole("button", { name: "PRJ-2: Other work" }).click();
  await page.getByLabel("Board handoff").fill("written here");
  await page.getByLabel("Board handoff").blur();
  const dialog = await syncTab(page);
  const input = dialog.getByLabel("Import snapshot file");

  await input.setInputFiles({
    name: "jirasync-snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(remoteSnapshot(jira.baseUrl)),
  });
  await expect(dialog.getByRole("status")).toContainText(
    "notes kept local (different here): PRJ-2",
  );
  await input.setInputFiles({
    name: "other.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"format":"other"}'),
  });
  await expect(dialog.getByRole("alert")).toHaveText("This file is not a JiraSync snapshot");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Board handoff")).toHaveValue("written here");
});

test("git sync pulls, merges and pushes a snapshot; a working run blocks it", async ({ page }) => {
  await seed(page, {});
  const jira = await openSync(page);
  await page.evaluate((remote) => {
    window.__e2e!.harness!.snapshot = { remote, pushed: [] };
  }, remoteSnapshot(jira.baseUrl));
  const dialog = await syncTab(page);
  await dialog.getByLabel(/Git sync folder/).fill("C:\\src\\jirasync-sync");
  await dialog.getByRole("button", { name: "Sync now" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Imported 1 AI status · 1 note. Snapshot pushed.",
  );
  const pushed = (await readE2EState(page)).harness!.snapshot!.pushed;
  expect(pushed).toHaveLength(1);
  expect(JSON.parse(pushed[0]).aiStates).toEqual([
    expect.objectContaining({ issueKey: "PRJ-2", status: "review" }),
  ]);
  expect(pushed[0]).not.toContain("test-token");
  expect(await page.evaluate(() => localStorage.getItem("jirasync-snapshot-folder"))).toBe(
    "C:\\src\\jirasync-sync",
  );

  await page.evaluate(() => {
    window.__e2e!.harness!.snapshot!.busy = true;
  });
  await dialog.getByRole("button", { name: "Sync now" }).click();
  await expect(dialog.getByRole("alert")).toContainText("finish or stop it before syncing");
  expect((await readE2EState(page)).harness!.snapshot!.pushed).toHaveLength(1);
});
