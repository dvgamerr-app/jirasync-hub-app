import { expect, test, type Page } from "@playwright/test";
import { adfParagraph, FakeJira } from "./fake-jira";
import { getTask, idbAll, openApp, openTask, setNote, syncButton, toasts } from "./helpers";

async function openBoardTask(page: Page, key: string) {
  if (!page.url().endsWith("#/ai-board"))
    await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${key}:`) }).click();
  return page.getByRole("complementary", { name: `Board details ${key}`, exact: true });
}

test("context preview copies offline, preserves handoff, and excludes private data by default", async ({
  page,
  context,
}) => {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", description: adfParagraph("Keep API Case"), parent: "PRJ-2" });
  jira.addIssue({ key: "PRJ-2", summary: "Parent context", issuetype: "Epic" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, jira, { waitFor: "PRJ-1" });
  let panel = await openTask(page, "PRJ-1");
  await setNote(panel, "Private handoff");
  await panel.getByRole("button", { name: "Insert handoff template" }).click();
  await expect(panel.getByPlaceholder("Add a note...")).toHaveValue(/Private handoff\n\n## Done/);
  await expect.poll(async () => (await getTask(page, "PRJ-1"))?.note).toContain("## Next");
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  await expect(syncButton(page)).toBeEnabled();
  panel = await openBoardTask(page, "PRJ-1");
  await page.getByRole("button", { name: "Sync board", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sync board", exact: true })).toBeEnabled();
  // Finish the board's pull before measuring requests added by Copy.
  await expect.poll(() => jira.find("GET", "issue/PRJ-1/transitions").length).toBeGreaterThan(0);
  await expect
    .poll(() => jira.requests.every((request) => request.endedAt !== undefined))
    .toBe(true);
  const requestCount = jira.requests.length;
  await context.setOffline(true);
  await panel.getByRole("button", { name: "Copy for AI", exact: true }).click();
  const preview = page.getByRole("textbox", { name: "AI context preview" });
  await expect(preview).toHaveValue(/Keep API Case/);
  await expect(preview).toHaveValue(/PRJ-2: Parent context/);
  await expect(preview).not.toHaveValue(/Private handoff|test-token|me@acme.test/);
  await page.getByLabel("Include local note").check();
  await expect(preview).toHaveValue(/Private handoff/);
  const expected = await preview.inputValue();
  await page.getByRole("button", { name: "Copy context", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, "\n")).toBe(expected);
  expect(jira.requests.length).toBe(requestCount);
});

test("comment and worklog succeed independently and a DB failure can be retried without reposting", async ({
  page,
}) => {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  let panel = await openTask(page, "PRJ-1");
  await setNote(panel, "Never post this private note");
  panel = await openBoardTask(page, "PRJ-1");
  await panel.getByRole("button", { name: "Summarize to Jira" }).click();
  await page.getByLabel("Summary", { exact: true }).fill("Reviewed AI changes");
  await page.getByLabel("Time spent", { exact: true }).fill("30m");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByText("Comment posted", { exact: true })).toBeVisible();
  expect(jira.find("POST", "issue/PRJ-1/comment")).toHaveLength(1);
  expect(JSON.stringify(jira.find("POST", "issue/PRJ-1/comment")[0].body)).not.toContain(
    "private note",
  );
  expect(jira.find("POST", "issue/PRJ-1/worklog")).toHaveLength(0);
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "workLogs") {
        IDBObjectStore.prototype.put = original;
        throw new DOMException("Injected DB failure", "QuotaExceededError");
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: "Add worklog", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Injected DB failure");
  await expect(page.getByLabel("Time spent", { exact: true })).toHaveValue("30m");
  expect(await idbAll(page, "workLogs")).toHaveLength(0);
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  await page.getByRole("button", { name: "Add worklog", exact: true }).click();
  await expect(page.getByText("Worklog saved locally — not pushed", { exact: true })).toBeVisible();
  expect(await idbAll(page, "workLogs")).toHaveLength(1);
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(true);
  expect(jira.find("POST", "issue/PRJ-1/comment")).toHaveLength(1);
  expect(jira.find("POST", "issue/PRJ-1/worklog")).toHaveLength(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByRole("button", { name: "Summarize to Jira" }).click();
  await expect(page.getByText("Comment posted", { exact: true })).toBeVisible();
  await expect(page.getByText("Worklog saved locally — not pushed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add worklog", exact: true })).toHaveCount(0);
});

test("drafts and in-flight comments stay on their ticket when selection changes", async ({
  page,
}) => {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1" });
  jira.addIssue({ key: "PRJ-2" });
  jira.delay((request) => request.path === "issue/PRJ-1/comment", 1500, 1);
  await openApp(page, jira, { waitFor: "PRJ-1" });
  let panel = await openBoardTask(page, "PRJ-1");
  await panel.getByRole("button", { name: "Summarize to Jira" }).click();
  await page.getByLabel("Summary", { exact: true }).fill("Summary for A");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  panel = await openBoardTask(page, "PRJ-2");
  await panel.getByRole("button", { name: "Summarize to Jira" }).click();
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("");
  await page.getByLabel("Summary", { exact: true }).fill("Unsent summary for B");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  panel = await openBoardTask(page, "PRJ-1");
  await panel.getByRole("button", { name: "Summarize to Jira" }).click();
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Summary for A");
  await expect(page.getByText("Comment posted", { exact: true })).toBeVisible();
  expect(jira.find("POST", "issue/PRJ-1/comment")).toHaveLength(1);
  expect(jira.find("POST", "issue/PRJ-2/comment")).toHaveLength(0);
});

test("rejected comments retain text for retry while uncertain results require checking Jira", async ({
  page,
}) => {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1" });
  jira.fail(
    (request) => request.path === "issue/PRJ-1/comment",
    403,
    { message: "Comment forbidden" },
    1,
  );
  await openApp(page, jira, { waitFor: "PRJ-1" });
  const panel = await openBoardTask(page, "PRJ-1");
  await panel.getByRole("button", { name: "Summarize to Jira" }).click();
  await page.getByLabel("Summary", { exact: true }).fill("Keep this draft");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Comment forbidden");
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByText("Comment posted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start a new comment", exact: true }).click();
  jira.fail((request) => request.path === "issue/PRJ-1/comment", 500, {}, 1);
  await page.getByLabel("Summary", { exact: true }).fill("Uncertain comment");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Result unknown");
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Uncertain comment");
  await expect(page.getByRole("button", { name: "Post comment", exact: true })).toHaveCount(0);
  expect(jira.find("POST", "issue/PRJ-1/comment")).toHaveLength(3);
});

test("Log Work keeps its form after a database failure and closes only after a successful save", async ({
  page,
}) => {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  const panel = await openTask(page, "PRJ-1");
  await panel.getByRole("button", { name: "Log Time", exact: true }).click();
  const time = page.getByPlaceholder("e.g. 1d 2h 30m");
  const comment = page.getByPlaceholder("What did you work on?");
  await time.fill("45m");
  await comment.fill("Keep this worklog");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "workLogs") {
        IDBObjectStore.prototype.put = original;
        throw new DOMException("Injected Log Work failure", "QuotaExceededError");
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: "Log Work", exact: true }).click();
  await expect(toasts(page).filter({ hasText: "Could not save worklog" })).toBeVisible();
  await expect(time).toHaveValue("45m");
  await expect(comment).toHaveValue("Keep this worklog");
  expect(await idbAll(page, "workLogs")).toHaveLength(0);
  await page.getByRole("button", { name: "Log Work", exact: true }).click();
  await expect(time).toHaveCount(0);
  expect(await idbAll(page, "workLogs")).toHaveLength(1);
  expect(jira.find("POST", "issue/PRJ-1/worklog")).toHaveLength(0);
});
