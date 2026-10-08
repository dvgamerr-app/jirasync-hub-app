import { expect, test } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { getTask, idbAll, openApp, openTask, pushAll, pushButton, row, toasts } from "./helpers";

function oneIssue() {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", summary: "Estimate me" });
  return jira;
}

test.describe("Mandays field", () => {
  test("positive: a plain number means days, shows how it was read, and is pushed as that estimate", async ({
    page,
  }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    const input = panel.getByPlaceholder("e.g. 1d 4h 30m");

    await input.fill("2");
    await expect(panel.getByTestId("manday-preview")).toHaveText("= 2d (16h)");
    await input.blur();
    await expect.poll(async () => (await getTask(page, "PRJ-1"))?.mandays).toBe(2);

    await pushAll(page);
    await expect.poll(() => jira.mustGet("PRJ-1").originalEstimateSeconds).toBe(2 * 8 * 3600);
  });

  test("positive: day/hour/minute text is still understood", async ({ page }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    const input = panel.getByPlaceholder("e.g. 1d 4h 30m");

    await input.fill("1d 4h");
    await expect(panel.getByTestId("manday-preview")).toHaveText("= 1d 4h (12h)");
    await input.blur();
    await expect.poll(async () => (await getTask(page, "PRJ-1"))?.mandays).toBe(1.5);
  });

  test("negative: unrecognised text shows an error and leaves the value untouched", async ({
    page,
  }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    const input = panel.getByPlaceholder("e.g. 1d 4h 30m");

    await input.fill("abc");
    await expect(panel.getByRole("alert")).toContainText("Not recognised");
    await expect(panel.getByTestId("manday-preview")).toHaveCount(0);
    await input.blur();

    expect((await getTask(page, "PRJ-1"))?.mandays ?? null).toBeNull();
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
    await expect(pushButton(page)).toHaveCount(0);
  });

  test("negative: a plain number is not treated as hours (2 is not 0.25 manday)", async ({
    page,
  }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await panel.getByPlaceholder("e.g. 1d 4h 30m").fill("2");
    await panel.getByPlaceholder("e.g. 1d 4h 30m").blur();

    await expect.poll(async () => (await getTask(page, "PRJ-1"))?.mandays).not.toBe(0.25);
  });

  test("positive: the inline table cell also reads a plain number as days", async ({ page }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });

    await row(page, "PRJ-1").getByRole("cell").nth(6).getByText("—").click();
    await page.getByLabel("Edit mandays for task-acc1-PRJ-1").fill("3");
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await getTask(page, "PRJ-1"))?.mandays).toBe(3);
  });

  test("negative: invalid text typed into the inline cell is discarded", async ({ page }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });

    await row(page, "PRJ-1").getByRole("cell").nth(6).getByText("—").click();
    await page.getByLabel("Edit mandays for task-acc1-PRJ-1").fill("zzz");
    await page.keyboard.press("Enter");

    await expect(row(page, "PRJ-1").getByRole("cell").nth(6)).toContainText("—");
    expect((await getTask(page, "PRJ-1"))?.mandays ?? null).toBeNull();
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  });
});

test.describe("Log Work time field", () => {
  async function openLogWork(page: import("@playwright/test").Page) {
    const panel = await openTask(page, "PRJ-1");
    await panel.getByRole("button", { name: "Log Time" }).click();
    return page.getByPlaceholder("e.g. 1d 2h 30m");
  }

  test("positive: minutes are previewed without warning and logged as typed", async ({ page }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const input = await openLogWork(page);

    await input.fill("30m");
    await expect(page.getByTestId("logwork-preview")).toHaveText("= 30m (0.5h)");
    await expect(page.getByTestId("logwork-preview")).not.toContainText("more than 24h");
    await page.getByRole("button", { name: "Log Work", exact: true }).click();

    await expect
      .poll(
        async () =>
          (await idbAll<{ timeSpentMinutes: number }>(page, "workLogs"))[0]?.timeSpentMinutes,
      )
      .toBe(30);
  });

  test("positive: a bare number is previewed as hours and an implausible amount is flagged", async ({
    page,
  }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const input = await openLogWork(page);

    await input.fill("30");

    await expect(page.getByTestId("logwork-preview")).toContainText("(30h)");
    await expect(page.getByTestId("logwork-preview")).toContainText("more than 24h");
    await expect(page.getByTestId("logwork-preview")).toContainText("write 30m for minutes");
  });

  test("negative: normal amounts show no warning", async ({ page }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const input = await openLogWork(page);

    await input.fill("2h");

    await expect(page.getByTestId("logwork-preview")).toHaveText("= 2h (2h)");
    await expect(page.getByTestId("logwork-preview")).not.toContainText("more than 24h");
  });

  test("negative: unrecognised text is flagged and nothing is logged", async ({ page }) => {
    const jira = oneIssue();
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const input = await openLogWork(page);

    await input.fill("abc");
    await expect(page.getByRole("alert").filter({ hasText: "Not recognised" })).toBeVisible();
    await page.getByRole("button", { name: "Log Work", exact: true }).click();

    await expect(toasts(page).filter({ hasText: "Invalid time" })).toBeVisible();
    expect(await idbAll(page, "workLogs")).toHaveLength(0);
  });
});
