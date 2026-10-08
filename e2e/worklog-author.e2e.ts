import { expect, test } from "@playwright/test";
import { FakeJira, OTHER } from "./fake-jira";
import { idbAll, openApp, openTask, pushButton, readE2EState, row, syncButton } from "./helpers";

const HOUR = 3600;

function sharedTicket(jira: FakeJira) {
  jira.addIssue({ key: "PRJ-1", summary: "Shared ticket" });
  jira.addWorklog("PRJ-1", { started: "2026-03-15T09:00:00.000+0000", timeSpentSeconds: HOUR });
  jira.addWorklog("PRJ-1", {
    started: "2026-03-16T09:00:00.000+0000",
    timeSpentSeconds: 3 * HOUR,
    author: OTHER,
  });
}

async function saveCsv(page: import("@playwright/test").Page): Promise<string[][]> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("button", { name: "Save CSV" }).click();
  await expect.poll(async () => Object.keys((await readE2EState(page)).files).length).toBe(1);
  const content = Object.values((await readE2EState(page)).files)[0];
  return content.split("\n").map((line) => line.split(","));
}

test.describe("worklog author: only my own time counts", () => {
  test("positive: table time, detail total and CSV count only my worklogs on a shared ticket", async ({
    page,
  }) => {
    const jira = new FakeJira();
    sharedTicket(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });

    // Table "Time" column: 1h (mine), not 4h (mine + teammate)
    await expect(row(page, "PRJ-1")).toContainText("1h");
    await expect(row(page, "PRJ-1")).not.toContainText("4h");

    // CSV: Usage Time (min) = 60
    const [header, dataRow] = await saveCsv(page);
    expect(header[7]).toBe("Usage Time (min)");
    expect(dataRow[7]).toBe("60");
  });

  test("positive: detail panel lists the teammate's worklog read-only with their name", async ({
    page,
  }) => {
    const jira = new FakeJira();
    sharedTicket(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await expect(panel.getByTestId("worklog-own")).toHaveCount(1);
    const other = panel.getByTestId("worklog-other");
    await expect(other).toHaveCount(1);
    await expect(other).toContainText("by Other Person");
    await expect(other).toContainText("3h");
    await expect(panel.getByText("Total: 1h")).toBeVisible();
    await expect(panel.getByTestId("others-total")).toContainText("Others: 3h");
  });

  test("negative: a teammate's worklog has no delete button and is never deleted in Jira", async ({
    page,
  }) => {
    const jira = new FakeJira();
    sharedTicket(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await expect(panel.getByTestId("worklog-other").getByTitle("Delete work log")).toHaveCount(0);
    await expect(panel.getByTestId("worklog-own").getByTitle("Delete work log")).toHaveCount(1);

    // delete my own worklog and push: only my worklog id is DELETEd
    await panel.getByTestId("worklog-own").getByTitle("Delete work log").click();
    await pushButton(page).click();
    await expect.poll(() => jira.find("DELETE", /^issue\/PRJ-1\/worklog\//).length).toBe(1);
    const deleted = jira
      .find("DELETE", /^issue\/PRJ-1\/worklog\//)[0]
      .path.split("/")
      .pop();
    const remaining = jira.mustGet("PRJ-1").worklogs;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].author.accountId).toBe(OTHER.accountId);
    expect(remaining[0].id).not.toBe(deleted);
  });

  test("negative: a ticket where only a teammate logged time shows no time and exports nothing", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-2", summary: "Teammate only" });
    jira.addWorklog("PRJ-2", {
      started: "2026-03-15T09:00:00.000+0000",
      timeSpentSeconds: 5 * HOUR,
      author: OTHER,
    });
    await openApp(page, jira, { waitFor: "PRJ-2" });

    await expect(row(page, "PRJ-2")).not.toContainText("5h");

    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByText("No worklogs found for this month")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save CSV" })).toBeDisabled();
  });

  test("positive: worklogs keep their author flag after a re-sync (isOwn is persisted)", async ({
    page,
  }) => {
    const jira = new FakeJira();
    sharedTicket(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await syncButton(page).click();
    await expect(syncButton(page)).toBeEnabled();

    const logs = await idbAll<{ isOwn: boolean | null; authorName: string | null }>(
      page,
      "workLogs",
    );
    expect(logs.filter((l) => l.isOwn === true)).toHaveLength(1);
    expect(logs.filter((l) => l.isOwn === false).map((l) => l.authorName)).toEqual([
      "Other Person",
    ]);
  });
});
