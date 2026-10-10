import { expect, test, type Page } from "@playwright/test";
import { FakeJira, OTHER } from "./fake-jira";
import { logWork, openApp, openTask, pushAll, pushButton, readE2EState, setNote } from "./helpers";

const HOUR = 3600;

async function openExport(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Export CSV")).toBeVisible();
}

async function savedCsv(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Save CSV" }).click();
  await expect.poll(async () => Object.keys((await readE2EState(page)).files).length).toBe(1);
  return Object.values((await readE2EState(page)).files)[0];
}

function ticketWithLog(jira: FakeJira) {
  jira.addIssue({ key: "PRJ-1", summary: "Thai note" });
  jira.addWorklog("PRJ-1", { started: "2026-03-15T09:00:00.000+0000", timeSpentSeconds: HOUR });
}

test.describe("CSV file encoding", () => {
  test("positive: the saved file starts with a UTF-8 BOM and keeps Thai text intact", async ({
    page,
  }) => {
    const jira = new FakeJira();
    ticketWithLog(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setNote(panel, "ทดสอบการส่งออก");

    await openExport(page);
    const csv = await savedCsv(page);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("ทดสอบการส่งออก");
    expect(csv.slice(1).startsWith("FullName,Project,Month,Year")).toBe(true);
  });

  test("negative: copying to the clipboard does not add a BOM", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const jira = new FakeJira();
    ticketWithLog(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });

    await openExport(page);
    await page.getByRole("button", { name: "Copy CSV" }).click();
    await expect(page.getByText("Copied to clipboard", { exact: true })).toBeVisible();

    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).toContain("PRJ");
  });
});

test.describe("export covers every ticket I logged time on", () => {
  function createdByMe(jira: FakeJira) {
    jira.addIssue({
      key: "PRJ-9",
      summary: "I created it, someone else works on it",
      assignee: OTHER,
      creator: jira.me,
    });
    jira.addWorklog("PRJ-9", {
      started: "2026-03-12T09:00:00.000+0000",
      timeSpentSeconds: 2 * HOUR,
    });
    jira.addIssue({
      key: "PRJ-8",
      summary: "I created it, never logged on it",
      assignee: OTHER,
      creator: jira.me,
    });
  }

  test("positive: time I logged on a ticket that is now assigned to someone else is exported", async ({
    page,
  }) => {
    const jira = new FakeJira();
    ticketWithLog(jira);
    createdByMe(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });

    await openExport(page);
    const lines = (await savedCsv(page)).slice(1).split("\n");

    expect(lines).toHaveLength(3); // header + PRJ-1 + PRJ-9
    expect(lines.some((line) => line.includes("/browse/PRJ-9") && line.includes(",120,"))).toBe(
      true,
    );
  });

  test("negative: a created-by-me ticket without any of my worklogs adds no row", async ({
    page,
  }) => {
    const jira = new FakeJira();
    ticketWithLog(jira);
    createdByMe(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });

    await openExport(page);
    const csv = await savedCsv(page);

    expect(csv).not.toContain("/browse/PRJ-8");
  });
});

test.describe("export warns about worklogs that are not on Jira yet", () => {
  test("positive: unpushed time is called out, and the warning disappears after the push", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Fresh time" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await logWork(page, panel, "1h 30m");

    await openExport(page);
    const warning = page.getByTestId("export-unsynced");
    await expect(warning).toContainText("1 worklog(s) (1h 30m)");
    await expect(warning).toContainText("not pushed to Jira yet");

    await page.keyboard.press("Escape");
    await pushAll(page);
    await expect(pushButton(page)).toHaveCount(0);
    await openExport(page);
    await expect(page.getByTestId("export-unsynced")).toHaveCount(0);
  });

  test("negative: when every worklog is already on Jira there is no warning", async ({ page }) => {
    const jira = new FakeJira();
    ticketWithLog(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });

    await openExport(page);

    await expect(page.getByText("1 worklog(s) ready to export")).toBeVisible();
    await expect(page.getByTestId("export-unsynced")).toHaveCount(0);
  });
});
