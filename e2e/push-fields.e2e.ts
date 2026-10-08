import { expect, test } from "@playwright/test";
import { adfParagraph, FakeJira } from "./fake-jira";
import {
  getTask,
  idbAll,
  idbPut,
  logWork,
  openApp,
  openTask,
  pullFromJira,
  pushAll,
  pushButton,
  row,
  setMandays,
  setNote,
  setSeverity,
  setStatus,
  setType,
  toasts,
} from "./helpers";

const SP_MAPPING = {
  "jira-story-point-fields": JSON.stringify({ "proj-acc1-PRJ": "customfield_10016" }),
};

function richIssue(jira: FakeJira) {
  return jira.addIssue({
    key: "PRJ-1",
    summary: "Rich issue",
    issuetype: "Story",
    priority: "Lowest",
    storyPoints: 8, // a value the UI cannot represent (only 1/2/3/5)
    description: adfParagraph("Original description written in Jira"),
    originalEstimateSeconds: 2 * 8 * 3600,
  });
}

test.describe("push sends only the fields the user edited", () => {
  test("positive: editing severity sends exactly one field (priority)", async ({ page }) => {
    const jira = new FakeJira();
    richIssue(jira);
    await openApp(page, jira, { waitFor: "PRJ-1", storage: SP_MAPPING });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await pushAll(page);

    await expect.poll(() => jira.putFields("PRJ-1").length).toBe(1);
    expect(jira.putFields("PRJ-1")[0]).toEqual({ priority: { name: "High" } });
    await expect(pushButton(page)).toHaveCount(0);
  });

  test("negative: untouched story points / description / estimate in Jira are not overwritten", async ({
    page,
  }) => {
    const jira = new FakeJira();
    richIssue(jira);
    await openApp(page, jira, { waitFor: "PRJ-1", storage: SP_MAPPING });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await pushAll(page);
    await expect.poll(() => jira.putFields("PRJ-1").length).toBe(1);

    const sent = jira.putFields("PRJ-1")[0];
    expect(Object.keys(sent)).toEqual(["priority"]);
    const issue = jira.mustGet("PRJ-1");
    expect(issue.storyPoints).toBe(8); // not wiped to null
    expect(JSON.stringify(issue.description)).toContain("Original description written in Jira");
    expect(issue.originalEstimateSeconds).toBe(2 * 8 * 3600);
  });

  test("positive: editing mandays sends timetracking only, and the local note never reaches Jira", async ({
    page,
  }) => {
    const jira = new FakeJira();
    richIssue(jira);
    await openApp(page, jira, { waitFor: "PRJ-1", storage: SP_MAPPING });
    const panel = await openTask(page, "PRJ-1");

    await setMandays(panel, "1d 4h");
    await setNote(panel, "my note for jira");
    await pushAll(page);

    await expect.poll(() => jira.putFields("PRJ-1").length).toBe(1);
    expect(Object.keys(jira.putFields("PRJ-1")[0])).toEqual(["timetracking"]);
    expect(jira.mustGet("PRJ-1").originalEstimateSeconds).toBe(12 * 3600);
    expect(JSON.stringify(jira.mustGet("PRJ-1").description)).toContain(
      "Original description written in Jira",
    );
    expect((await getTask(page, "PRJ-1"))?.note).toBe("my note for jira");
    expect(jira.mustGet("PRJ-1").priority).toBe("Lowest"); // not remapped to Low
  });

  test("positive: editing story level sends only the mapped story point field", async ({
    page,
  }) => {
    const jira = new FakeJira();
    richIssue(jira);
    await openApp(page, jira, { waitFor: "PRJ-1", storage: SP_MAPPING });
    const panel = await openTask(page, "PRJ-1");

    await page
      .getByText("Story Level", { exact: true })
      .locator("..")
      .getByRole("combobox")
      .click();
    await page.getByRole("option", { name: "3", exact: true }).click();
    await pushAll(page);

    await expect.poll(() => jira.putFields("PRJ-1").length).toBe(1);
    expect(jira.putFields("PRJ-1")[0]).toEqual({ customfield_10016: 3 });
    await expect(panel).toBeVisible();
  });

  test("negative: logging work alone triggers no issue update at all, only the worklog", async ({
    page,
  }) => {
    const jira = new FakeJira();
    richIssue(jira);
    await openApp(page, jira, { waitFor: "PRJ-1", storage: SP_MAPPING });
    const panel = await openTask(page, "PRJ-1");

    await logWork(page, panel, "1h", "pairing");
    await pushAll(page);

    await expect.poll(() => jira.find("POST", "issue/PRJ-1/worklog").length).toBe(1);
    expect(jira.find("PUT", "issue/PRJ-1")).toHaveLength(0);
    expect(jira.find("POST", "issue/PRJ-1/transitions")).toHaveLength(0);
    const issue = jira.mustGet("PRJ-1");
    expect(issue.storyPoints).toBe(8);
    expect(issue.priority).toBe("Lowest");
    await expect(pushButton(page)).toHaveCount(0);
  });
});

test.describe("issue type is pushed", () => {
  function twoTypes(jira: FakeJira) {
    jira.addIssue({ key: "PRJ-1", summary: "Change my type", issuetype: "Task" });
    jira.addIssue({ key: "PRJ-2", summary: "Other issue", issuetype: "Bug" });
  }

  test("positive: changing Type to Bug updates the issue type in Jira", async ({ page }) => {
    const jira = new FakeJira();
    twoTypes(jira);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setType(page, panel, "Bug");
    await pushAll(page);

    await expect.poll(() => jira.putFields("PRJ-1").length).toBe(1);
    expect(jira.putFields("PRJ-1")[0]).toEqual({ issuetype: { name: "Bug" } });
    expect(jira.mustGet("PRJ-1").issuetype).toBe("Bug");
  });

  test("negative: an unchanged Type is never sent, and a rejected type change keeps the task unsynced", async ({
    page,
  }) => {
    const jira = new FakeJira();
    twoTypes(jira);
    jira.fail((r) => r.method === "PUT" && r.path === "issue/PRJ-1", 400, {
      errorMessages: ["Issue type not allowed"],
    });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setType(page, panel, "Bug");
    await pushAll(page);

    await expect(toasts(page).filter({ hasText: "Issue type not allowed" })).toBeVisible();
    await expect(pushButton(page)).toBeVisible(); // still dirty
    expect(jira.mustGet("PRJ-1").issuetype).toBe("Task"); // unchanged in Jira
    const stored = await getTask(page, "PRJ-1");
    expect(stored?.isDirty).toBe(true);
  });
});

test.describe("status transition failures are surfaced", () => {
  test("positive: an allowed transition moves the issue and clears the dirty state", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Move me" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setStatus(page, panel, "In Progress");
    await pushAll(page);

    await expect.poll(() => jira.mustGet("PRJ-1").status).toBe("In Progress");
    await expect(pushButton(page)).toHaveCount(0);
    expect(jira.find("PUT", "issue/PRJ-1")).toHaveLength(0); // no field update for a status-only edit
  });

  test("negative: a blocked transition shows an error and the task stays unsynced", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Move me" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    // The workflow changes in Jira after the panel already loaded the reachable statuses.
    await expect.poll(() => jira.find("GET", "issue/PRJ-1/transitions").length).toBeGreaterThan(0);
    jira.mustGet("PRJ-1").blockedStatuses = ["In Review"];

    await setStatus(page, panel, "In Review");
    await pushAll(page);

    await expect(
      toasts(page).filter({ hasText: 'Could not move PRJ-1 to "In Review"' }),
    ).toBeVisible();
    await expect(pushButton(page)).toBeVisible();
    expect(jira.mustGet("PRJ-1").status).toBe("To Do");
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(true);
  });
});

test.describe("worklogs are pushed even when the field update fails", () => {
  test("positive: a rejected field update does not block the logged time", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "No edit permission" });
    jira.fail((r) => r.method === "PUT" && r.path === "issue/PRJ-1", 403, {
      errorMessages: ["You do not have permission to edit this issue"],
    });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await logWork(page, panel, "2h");
    await pushAll(page);

    await expect.poll(() => jira.mustGet("PRJ-1").worklogs.length).toBe(1);
    expect(jira.mustGet("PRJ-1").worklogs[0].timeSpentSeconds).toBe(2 * 3600);
    await expect(toasts(page).filter({ hasText: "permission" })).toBeVisible();
    await expect(pushButton(page)).toBeVisible(); // severity still pending
  });

  test("negative: with no failure the same edit fully syncs and nothing is left pending", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Fine" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await logWork(page, panel, "2h");
    await pushAll(page);

    await expect.poll(() => jira.mustGet("PRJ-1").worklogs.length).toBe(1);
    expect(jira.mustGet("PRJ-1").priority).toBe("High");
    await expect(pushButton(page)).toHaveCount(0);
    const pending = (await idbAll<{ syncStatus: string }>(page, "workLogs")).filter(
      (w) => w.syncStatus !== "synced",
    );
    expect(pending).toHaveLength(0);
  });
});

test.describe("edits made while a push is in flight are kept", () => {
  test("positive: an estimate typed during the push survives and is pushed next time", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Slow push" });
    jira.delay((r) => r.method === "PUT" && r.path === "issue/PRJ-1", 1500, 1);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await pushAll(page);
    await expect.poll(() => jira.find("PUT", "issue/PRJ-1").length).toBe(1); // push is in flight
    await setMandays(panel, "2");

    // the first push finishes, but the task is NOT marked synced: the estimate is still pending
    await expect.poll(() => jira.mustGet("PRJ-1").priority).toBe("High");
    await expect(pushButton(page)).toBeVisible();
    expect((await getTask(page, "PRJ-1"))?.mandays).toBe(2);
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(true);

    await pushAll(page);
    await expect.poll(() => jira.mustGet("PRJ-1").originalEstimateSeconds).toBe(2 * 8 * 3600);
    await expect(pushButton(page)).toHaveCount(0);
  });

  test("negative: without a concurrent edit the task becomes clean after the push", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Slow push" });
    jira.delay((r) => r.method === "PUT" && r.path === "issue/PRJ-1", 800, 1);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await pushAll(page);

    await expect(pushButton(page)).toHaveCount(0, { timeout: 15_000 });
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  });
});

test.describe("pull and push never run at the same time", () => {
  test("positive: a Sync clicked during a push waits until the push has finished", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Slow push" });
    jira.delay((r) => r.method === "PUT" && r.path === "issue/PRJ-1", 1500, 1);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");

    await setSeverity(page, panel, "High");
    await pushAll(page);
    await expect.poll(() => jira.find("PUT", "issue/PRJ-1").length).toBe(1);
    const put = jira.find("PUT", "issue/PRJ-1")[0];
    const searchesBefore = jira.find("POST", "search/jql").length;

    await page.locator("header").getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => jira.find("POST", "search/jql").length).toBeGreaterThan(searchesBefore);

    const pullStart = jira.find("POST", "search/jql")[searchesBefore].startedAt;
    expect(put.endedAt).toBeDefined();
    expect(pullStart).toBeGreaterThanOrEqual(put.endedAt!);
  });

  test("negative: with no push in flight a Sync reaches Jira immediately", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Idle" });
    await openApp(page, jira, { waitFor: "PRJ-1" });

    const before = jira.find("POST", "search/jql").length;
    const clickedAt = Date.now();
    await page.locator("header").getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => jira.find("POST", "search/jql").length).toBeGreaterThan(before);
    expect(Date.now() - clickedAt).toBeLessThan(1500);
  });
});

test.describe("a pull keeps only what the user really edited", () => {
  test("positive: a task dirty only because of a worklog still picks up Jira's new priority", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Worklog only", priority: "Low" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await logWork(page, panel, "1h");
    await expect(pushButton(page)).toBeVisible();

    jira.mustGet("PRJ-1").priority = "Highest"; // changed by a teammate in Jira
    await pullFromJira(page, jira);

    await expect.poll(async () => (await getTask(page, "PRJ-1"))?.severity).toBe("Critical");
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(true); // worklog still pending
  });

  test("negative: a locally edited severity is not overwritten by a pull", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Edited locally", priority: "Medium" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "High");

    jira.mustGet("PRJ-1").priority = "Low";
    await pullFromJira(page, jira);

    await expect(pushButton(page)).toBeVisible();
    expect((await getTask(page, "PRJ-1"))?.severity).toBe("High");
  });

  test("positive: a legacy dirty record (no dirtyFields) still pushes all of its local values", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Legacy", priority: "Medium" });
    await openApp(page, jira, { waitFor: "PRJ-1" });

    const stored = (await getTask(page, "PRJ-1")) as Record<string, unknown>;
    const legacy: Record<string, unknown> = {
      ...stored,
      severity: "High",
      isDirty: true,
      isSynced: false,
    };
    delete legacy.dirtyFields;
    await idbPut(page, "tasks", legacy);
    await page.reload();
    await expect(row(page, "PRJ-1")).toBeVisible();
    await expect(pushButton(page)).toBeVisible();

    await pushAll(page);

    await expect.poll(() => jira.mustGet("PRJ-1").priority).toBe("High");
  });
});

test.describe("note survives a pull", () => {
  test("positive: a note stays local — task not dirty, kept after the next sync", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Keep my note" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setNote(panel, "remember this");
    await expect(pushButton(page)).toHaveCount(0); // nothing to push
    expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);

    await pullFromJira(page, jira);

    expect((await getTask(page, "PRJ-1"))?.note).toBe("remember this");
    expect(jira.find("PUT", "issue/PRJ-1")).toHaveLength(0);
  });

  test("negative: a note on one task never appears on another task", async ({ page }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Has note" });
    jira.addIssue({ key: "PRJ-2", summary: "No note" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setNote(panel, "only for one");
    await pullFromJira(page, jira);

    expect((await getTask(page, "PRJ-2"))?.note ?? null).toBeNull();
  });
});
