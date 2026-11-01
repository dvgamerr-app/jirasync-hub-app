import { expect, test } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { getTask, openApp, row, syncButton } from "./helpers";

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

  test("navigation reuses memory without pulling or rereading task collections, while manual sync still updates the active page", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Cached task" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await expect(syncButton(page)).toBeEnabled();
    const pulls = jira.find("POST", "search/jql").length;
    await page.evaluate(() => {
      const counts = { reads: 0 };
      Object.assign(window, { collectionReads: counts });
      for (const method of ["get", "getAll", "openCursor", "count"] as const) {
        const original = IDBObjectStore.prototype[method];
        Object.defineProperty(IDBObjectStore.prototype, method, {
          value: function (this: IDBObjectStore, ...args: unknown[]) {
            if (
              ["tasks", "projects", "organizations", "workLogs", "aiBoardStates"].includes(
                this.name,
              )
            )
              counts.reads++;
            return Reflect.apply(original, this, args);
          },
        });
      }
    });
    await page.getByRole("link", { name: "AI Board", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "PRJ-1: Cached task", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "My Work", exact: true }).click();
    await expect(row(page, "PRJ-1")).toBeVisible();
    expect(jira.find("POST", "search/jql")).toHaveLength(pulls);
    expect(
      await page.evaluate(
        () => (window as unknown as { collectionReads: { reads: number } }).collectionReads.reads,
      ),
    ).toBe(0);

    jira.addIssue({ key: "PRJ-2", summary: "Arrived during manual sync" });
    jira.delay((request) => request.path === "search/jql", 500, 1);
    await syncButton(page).click();
    await expect(syncButton(page)).toBeDisabled();
    await page.getByRole("link", { name: "AI Board", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sync board", exact: true })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "PRJ-2: Arrived during manual sync", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync board", exact: true })).toBeEnabled();
    expect(jira.find("POST", "search/jql")).toHaveLength(pulls + 1);
  });
});
