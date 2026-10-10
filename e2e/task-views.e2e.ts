import { expect, test } from "@playwright/test";
import { adfParagraph, FakeJira, OTHER } from "./fake-jira";
import {
  getTask,
  idbAll,
  logWork,
  openApp,
  openTask,
  pushAll,
  pushButton,
  row,
  setSeverity,
  toasts,
} from "./helpers";

test.describe("tickets assigned to someone else are marked in My Work", () => {
  function mixed() {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Mine" });
    jira.addIssue({
      key: "PRJ-2",
      summary: "Reassigned away",
      status: "In Progress",
      assignee: OTHER,
      creator: OTHER,
    });
    return jira;
  }

  test("positive: a ticket now assigned to another person shows their name and is dimmed", async ({
    page,
  }) => {
    await openApp(page, mixed(), { waitFor: "PRJ-2" });

    await expect(row(page, "PRJ-2").getByTestId("assignee-other")).toHaveText("Other Person");
    await expect(row(page, "PRJ-2")).toHaveClass(/opacity-70/);
  });

  test("negative: my own tickets carry no assignee tag and are not dimmed", async ({ page }) => {
    await openApp(page, mixed(), { waitFor: "PRJ-1" });

    await expect(row(page, "PRJ-1").getByTestId("assignee-other")).toHaveCount(0);
    await expect(row(page, "PRJ-1")).not.toHaveClass(/opacity-70/);
  });
});

test.describe("worklogs that are not on Jira yet are labelled", () => {
  test("positive: a new worklog shows 'Not pushed' until it is pushed", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Log here" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await logWork(page, panel, "1h");
    await expect(panel.getByTestId("worklog-pending")).toHaveCount(1);

    await pushAll(page);
    await expect(pushButton(page)).toHaveCount(0);
    await expect(panel.getByTestId("worklog-pending")).toHaveCount(0);
    await expect(panel.getByTestId("worklog-own")).toHaveCount(1);
  });

  test("negative: worklogs already on Jira (mine or a teammate's) are never labelled", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Existing logs" });
    jira.addWorklog("PRJ-1", { started: "2026-03-10T09:00:00.000+0000", timeSpentSeconds: 3600 });
    jira.addWorklog("PRJ-1", {
      started: "2026-03-11T09:00:00.000+0000",
      timeSpentSeconds: 3600,
      author: OTHER,
    });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await expect(panel.getByTestId("worklog-own")).toHaveCount(1);
    await expect(panel.getByTestId("worklog-other")).toHaveCount(1);
    await expect(panel.getByTestId("worklog-pending")).toHaveCount(0);
  });
});

test.describe("search matches the text of a description, not its JSON", () => {
  function described() {
    const jira = new FakeJira();
    jira.addIssue({
      key: "PRJ-1",
      summary: "Alpha",
      description: adfParagraph("Deploy the payment gateway tonight"),
    });
    jira.addIssue({
      key: "PRJ-2",
      summary: "Beta",
      description: adfParagraph("Update the onboarding copy"),
    });
    return jira;
  }

  test("positive: a word from the description finds only the matching ticket", async ({ page }) => {
    await openApp(page, described(), { waitFor: "PRJ-1" });

    await page.getByPlaceholder("Search… (Ctrl+F)").fill("gateway");

    await expect(row(page, "PRJ-1")).toBeVisible();
    await expect(row(page, "PRJ-2")).toHaveCount(0);
  });

  test("negative: structural ADF words such as 'paragraph' or 'doc' match nothing", async ({
    page,
  }) => {
    await openApp(page, described(), { waitFor: "PRJ-1" });
    const search = page.getByPlaceholder("Search… (Ctrl+F)");

    await search.fill("paragraph");
    await expect(row(page, "PRJ-1")).toHaveCount(0);
    await expect(row(page, "PRJ-2")).toHaveCount(0);

    await search.fill("version");
    await expect(row(page, "PRJ-1")).toHaveCount(0);
  });

  test("positive: searching by key or title still works", async ({ page }) => {
    await openApp(page, described(), { waitFor: "PRJ-1" });
    const search = page.getByPlaceholder("Search… (Ctrl+F)");

    await search.fill("prj-2");
    await expect(row(page, "PRJ-2")).toBeVisible();
    await expect(row(page, "PRJ-1")).toHaveCount(0);

    await search.fill("alpha");
    await expect(row(page, "PRJ-1")).toBeVisible();
    await expect(row(page, "PRJ-2")).toHaveCount(0);
  });
});

test.describe("epic progress follows Jira's status category", () => {
  function epicWith(children: Array<{ key: string; status: string }>) {
    const jira = new FakeJira();
    jira.addIssue({ key: "EP-1", summary: "The epic", issuetype: "Epic", status: "In Progress" });
    for (const child of children) {
      jira.addIssue({ key: child.key, summary: child.key, status: child.status, parent: "EP-1" });
    }
    return jira;
  }

  test("positive: Resolved and Done children both count as finished", async ({ page }) => {
    const jira = epicWith([
      { key: "EP-2", status: "Resolved" },
      { key: "EP-3", status: "Done" },
      { key: "EP-4", status: "In Progress" },
    ]);
    await openApp(page, jira, { waitFor: "EP-1" });

    await expect(row(page, "EP-1")).toContainText("67% Done");
  });

  test("negative: children still in progress or review do not count as finished", async ({
    page,
  }) => {
    const jira = epicWith([
      { key: "EP-2", status: "In Review" },
      { key: "EP-3", status: "In Progress" },
    ]);
    await openApp(page, jira, { waitFor: "EP-1" });

    await expect(row(page, "EP-1")).toContainText("0% Done");
  });
});

test.describe("syncing one task reports why it failed", () => {
  test("positive: the toast carries Jira's reason", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Locked" });
    jira.fail((r) => r.method === "PUT" && r.path === "issue/PRJ-1", 403, {
      errorMessages: ["You do not have permission to edit this issue"],
    });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "High");

    await panel.getByRole("button", { name: "Sync", exact: true }).click();

    const toast = toasts(page).filter({ hasText: "Could not sync PRJ-1" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("permission");
    await expect(panel.getByRole("button", { name: "Sync", exact: true })).toBeVisible();
  });

  test("negative: a successful single-task sync shows no error and clears the Sync button", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Fine" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "High");

    await panel.getByRole("button", { name: "Sync", exact: true }).click();

    await expect(panel.getByRole("button", { name: "Sync", exact: true })).toHaveCount(0);
    await expect(toasts(page).filter({ hasText: "Could not sync" })).toHaveCount(0);
    expect(jira.mustGet("PRJ-1").priority).toBe("High");
  });
});

test.describe("a single task can be discarded", () => {
  test("positive: confirming restores Jira's values and drops the unpushed worklog", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Revert me", priority: "Medium" });
    jira.addIssue({ key: "PRJ-2", summary: "Leave me edited" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel2 = await openTask(page, "PRJ-2");
    await setSeverity(page, panel2, "Low");
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "Critical");
    await logWork(page, panel, "2h");

    await panel.getByRole("button", { name: "Discard", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard", exact: true })
      .click();

    await expect(panel.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await getTask(page, "PRJ-1"))?.severity).toBe("Medium");
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
    const logs = await idbAll<{ taskId: string }>(page, "workLogs");
    expect(logs.filter((l) => l.taskId.endsWith("PRJ-1"))).toHaveLength(0);
    expect(jira.find("PUT", "issue/PRJ-1")).toHaveLength(0); // nothing was pushed
    // the other task keeps its edit
    expect((await getTask(page, "PRJ-2"))?.isDirty).toBe(true);
  });

  test("negative: cancelling keeps the edits, and a clean task offers no Discard button", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Keep my edit", priority: "Medium" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await expect(panel.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);

    await setSeverity(page, panel, "Critical");
    await panel.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

    expect((await getTask(page, "PRJ-1"))?.severity).toBe("Critical");
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(true);
    await expect(pushButton(page)).toBeVisible();
  });

  test("negative: if Jira cannot be reached the task stays dirty and the error is shown", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Offline", priority: "Medium" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "Critical");
    jira.fail((r) => r.method === "GET" && r.path === "issue/PRJ-1", 500);

    await panel.getByRole("button", { name: "Discard", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard", exact: true })
      .click();

    await expect(toasts(page).filter({ hasText: "Could not restore PRJ-1" })).toBeVisible();
    expect((await getTask(page, "PRJ-1"))?.severity).toBe("Critical");
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(true);
  });
});
