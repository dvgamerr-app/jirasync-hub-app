import { expect, test } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { getTask, openApp, row } from "./helpers";

// Harness sanity checks: the app syncs from the fake Jira and renders the result.
test.describe("baseline", () => {
  test("positive: first load syncs the assigned issues from Jira into the table", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "First issue" });
    jira.addIssue({ key: "PRJ-2", summary: "Second issue", status: "In Progress" });

    await openApp(page, jira, { waitFor: "PRJ-1" });

    await expect(row(page, "PRJ-2")).toContainText("Second issue");
    const stored = await getTask(page, "PRJ-1");
    expect(stored?.isDirty).toBe(false);
  });

  test("negative: with no Jira account configured no request is made and the empty state asks for one", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1" });

    await openApp(page, jira, { accounts: [], waitFor: null });

    await expect(page.getByText("Add Jira Instance")).toBeVisible();
    expect(jira.requests).toHaveLength(0);
  });
});
