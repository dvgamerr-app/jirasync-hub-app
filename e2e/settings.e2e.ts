import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { idbAll, openApp, openTask, row, setSeverity } from "./helpers";

async function openSettings(page: Page) {
  await page.locator("aside").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog").getByText("Manage Jira connections")).toBeVisible();
}

async function fillAccountForm(page: Page, url: string) {
  await page.getByPlaceholder("acme or https://acme.atlassian.net").fill(url);
  await page.getByPlaceholder("you@company.com").fill("me@acme.test");
  await page.getByPlaceholder("Jira API token").fill("test-token");
}

test.describe("removing a Jira account asks for confirmation", () => {
  test("negative: cancelling keeps the account and its local tasks", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Keep me" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await openSettings(page);

    await page.getByRole("button", { name: "Remove Acme" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Remove Acme?");
    await confirm.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove Acme" })).toBeVisible();
    expect(await idbAll(page, "tasks")).toHaveLength(1);
  });

  test("positive: confirming removes the account and its local data", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Delete me" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await openSettings(page);

    await page.getByRole("button", { name: "Remove Acme" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove account" }).click();

    await expect(page.getByText("No Jira accounts configured yet.")).toBeVisible();
    await expect.poll(async () => (await idbAll(page, "tasks")).length).toBe(0);
  });

  test("positive: the confirmation warns how many tasks have unpushed changes", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Edited" });
    jira.addIssue({ key: "PRJ-2", summary: "Clean" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "High");
    await openSettings(page);

    await page.getByRole("button", { name: "Remove Acme" }).click();

    await expect(page.getByRole("alertdialog")).toContainText(
      "1 task(s) have changes that were not pushed to Jira",
    );
  });

  test("negative: no warning is shown when everything is already pushed", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Clean" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await openSettings(page);

    await page.getByRole("button", { name: "Remove Acme" }).click();

    await expect(page.getByRole("alertdialog")).toBeVisible();
    await expect(page.getByRole("alertdialog")).not.toContainText("not pushed");
  });
});

test.describe("Jira instance URL is validated in the form", () => {
  for (const valid of ["acme.atlassian.net", "acme", "https://acme.atlassian.net/"]) {
    test(`positive: "${valid}" is accepted and reaches https://acme.atlassian.net`, async ({
      page,
    }) => {
      const jira = new FakeJira();
      jira.addIssue({ key: "PRJ-1", summary: "Connected" });
      await openApp(page, jira, { accounts: [], waitFor: null });
      await openSettings(page);
      await page.getByRole("button", { name: "Add Account" }).click();

      await fillAccountForm(page, valid);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save & Connect" })).toBeEnabled();
      await page.getByRole("button", { name: "Save & Connect" }).click();

      await expect.poll(() => jira.find("GET", "myself").length).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: "Remove acme" })).toBeVisible();
    });
  }

  for (const invalid of [
    "jira.company.com",
    "https://evil.example.com",
    "http://acme.atlassian.net",
  ]) {
    test(`negative: "${invalid}" is rejected with a clear message and nothing is sent`, async ({
      page,
    }) => {
      const jira = new FakeJira();
      await openApp(page, jira, { accounts: [], waitFor: null });
      await openSettings(page);
      await page.getByRole("button", { name: "Add Account" }).click();

      await fillAccountForm(page, invalid);

      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("button", { name: "Save & Connect" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Test", exact: true })).toBeDisabled();
      expect(jira.requests).toHaveLength(0);
    });
  }

  test("negative: a task from a removed account does not stay in the table", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Will disappear" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await openSettings(page);
    await page.getByRole("button", { name: "Remove Acme" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove account" }).click();
    await page.keyboard.press("Escape");

    await expect(row(page, "PRJ-1")).toHaveCount(0);
  });
});
