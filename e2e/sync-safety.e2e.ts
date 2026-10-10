import { expect, test } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import {
  accountFor,
  idbAll,
  logWork,
  openApp,
  openTask,
  pullFromJira,
  pushAll,
  pushButton,
  row,
  setSeverity,
  syncButton,
  toasts,
} from "./helpers";

const HOUR = 3600;

function addHourLogs(jira: FakeJira, key: string, count: number) {
  for (let i = 0; i < count; i++) {
    jira.addWorklog(key, {
      started: `2026-03-${String((i % 27) + 1).padStart(2, "0")}T09:00:00.000+0000`,
      timeSpentSeconds: HOUR,
    });
  }
}

async function worklogCount(page: import("@playwright/test").Page, taskKey: string) {
  const logs = await idbAll<{ taskId: string }>(page, "workLogs");
  return logs.filter((l) => l.taskId.endsWith(`-${taskKey}`)).length;
}

test.describe("a failed worklog fetch never wipes logged time", () => {
  test("positive: when the full worklog list cannot be fetched the local worklogs are kept", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Long running ticket" });
    addHourLogs(jira, "PRJ-1", 25); // > 20, so Jira truncates the inline list
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await expect.poll(() => worklogCount(page, "PRJ-1")).toBe(25);

    jira.fail((r) => r.method === "GET" && r.path === "issue/PRJ-1/worklog", 429, {
      message: "rate limited",
    });
    await pullFromJira(page, jira);

    expect(await worklogCount(page, "PRJ-1")).toBe(25);
    await expect(row(page, "PRJ-1")).toContainText("3d 1h"); // 25h
  });

  test("negative: when the fetch succeeds, worklogs removed in Jira are removed locally too", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Long running ticket" });
    addHourLogs(jira, "PRJ-1", 25);
    jira.addIssue({ key: "PRJ-2", summary: "Short ticket" });
    addHourLogs(jira, "PRJ-2", 2);
    await openApp(page, jira, { waitFor: "PRJ-1" });
    await expect.poll(() => worklogCount(page, "PRJ-1")).toBe(25);

    jira.mustGet("PRJ-1").worklogs.splice(0, 3); // 22 left: still truncated
    jira.mustGet("PRJ-2").worklogs.splice(0, 1); // 1 left: inline
    await pullFromJira(page, jira);

    await expect.poll(() => worklogCount(page, "PRJ-1")).toBe(22);
    expect(await worklogCount(page, "PRJ-2")).toBe(1);
  });
});

test.describe("sync keeps work that has not been pushed", () => {
  function twoProjects(jira: FakeJira) {
    jira.addIssue({ key: "KEEP-1", summary: "Edited locally, vanishes from Jira query" });
    jira.addIssue({ key: "GONE-1", summary: "Untouched, vanishes from Jira query" });
    jira.addIssue({ key: "STAY-1", summary: "Stays visible" });
  }

  test("positive: an edited task survives its project disappearing from the Jira results", async ({
    page,
  }) => {
    const jira = new FakeJira();
    twoProjects(jira);
    await openApp(page, jira, { waitFor: "KEEP-1" });
    const panel = await openTask(page, "KEEP-1");
    await setSeverity(page, panel, "High");

    jira.mustGet("KEEP-1").inMainQuery = false;
    jira.mustGet("GONE-1").inMainQuery = false;
    await pullFromJira(page, jira);

    await expect(row(page, "KEEP-1")).toBeVisible();
    await expect(pushButton(page)).toBeVisible();
    await pushAll(page);
    await expect.poll(() => jira.mustGet("KEEP-1").priority).toBe("High");
  });

  test("positive: a task with an unpushed worklog also survives", async ({ page }) => {
    const jira = new FakeJira();
    twoProjects(jira);
    await openApp(page, jira, { waitFor: "KEEP-1" });
    const panel = await openTask(page, "KEEP-1");
    await logWork(page, panel, "3h");

    jira.mustGet("KEEP-1").inMainQuery = false;
    await pullFromJira(page, jira);

    await expect(row(page, "KEEP-1")).toBeVisible();
    await pushAll(page);
    await expect.poll(() => jira.mustGet("KEEP-1").worklogs.length).toBe(1);
  });

  test("negative: an untouched task in a vanished project is still cleaned up", async ({
    page,
  }) => {
    const jira = new FakeJira();
    twoProjects(jira);
    await openApp(page, jira, { waitFor: "GONE-1" });

    jira.mustGet("GONE-1").inMainQuery = false;
    await pullFromJira(page, jira);

    await expect(row(page, "GONE-1")).toHaveCount(0);
    await expect(row(page, "STAY-1")).toBeVisible();
    const tasks = await idbAll<{ jiraTaskId: string }>(page, "tasks");
    expect(tasks.map((t) => t.jiraTaskId)).not.toContain("GONE-1");
    const projects = await idbAll<{ jiraProjectKey: string }>(page, "projects");
    expect(projects.map((p) => p.jiraProjectKey)).not.toContain("GONE");
  });
});

test.describe("one broken account does not stop the others", () => {
  function twoAccounts() {
    const acme = new FakeJira("acme.atlassian.net");
    acme.addIssue({ key: "ACM-1", summary: "Acme issue" });
    const beta = new FakeJira("beta.atlassian.net");
    beta.me = { accountId: "acc-beta-me", displayName: "Beta Me" };
    beta.addIssue({ key: "BET-1", summary: "Beta issue", assignee: beta.me, creator: beta.me });
    const accounts = [
      accountFor(acme, { id: "acc1", name: "Acme" }),
      accountFor(beta, { id: "acc2", name: "Beta Corp" }),
    ];
    return { acme, beta, accounts };
  }

  test("positive: Acme still syncs while Beta's expired token is explained", async ({ page }) => {
    const { acme, beta, accounts } = twoAccounts();
    beta.fail(() => true, 401, { message: "Unauthorized" });
    await openApp(page, acme, { accounts, otherJira: [beta], waitFor: "ACM-1" });

    const toast = toasts(page).filter({ hasText: "Beta Corp" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("401");
    await expect(toast).toContainText("token may have expired");
    await expect(row(page, "BET-1")).toHaveCount(0);
  });

  test("negative: with both accounts healthy there is no error and both accounts' tasks load", async ({
    page,
  }) => {
    const { acme, beta, accounts } = twoAccounts();
    await openApp(page, acme, { accounts, otherJira: [beta], waitFor: "ACM-1" });
    await expect(row(page, "BET-1")).toBeVisible();
    await expect(toasts(page).filter({ hasText: "Sync Failed" })).toHaveCount(0);
  });

  test("negative: a non-auth failure is reported as-is, without the token hint", async ({
    page,
  }) => {
    const { acme, beta, accounts } = twoAccounts();
    beta.fail(() => true, 500, { message: "Internal error" });
    await openApp(page, acme, { accounts, otherJira: [beta], waitFor: "ACM-1" });

    const toast = toasts(page).filter({ hasText: "Beta Corp" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Jira API 500");
    await expect(toast).not.toContainText("token may have expired");
  });

  test("positive: when every account fails the sync reports failure and keeps the last good data", async ({
    page,
  }) => {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "Cached" });
    await openApp(page, jira, { waitFor: "PRJ-1" });

    jira.fail(() => true, 401, { message: "Unauthorized" });
    await syncButton(page).click();

    await expect(toasts(page).filter({ hasText: "Sync Failed" })).toBeVisible();
    await expect(toasts(page).filter({ hasText: "401" })).toBeVisible();
    await expect(row(page, "PRJ-1")).toBeVisible(); // cached data remains
  });
});

test.describe("worklog fetches are rate limited by the client", () => {
  function manyLongTickets(jira: FakeJira, count: number) {
    for (let i = 1; i <= count; i++) {
      jira.addIssue({ key: `PRJ-${i}`, summary: `Long ${i}` });
      addHourLogs(jira, `PRJ-${i}`, 25);
    }
  }

  test("positive: at most 4 per-issue worklog requests are in flight at once", async ({ page }) => {
    const jira = new FakeJira();
    manyLongTickets(jira, 12);
    jira.track("worklog-list", /^issue\/[^/]+\/worklog$/);
    jira.delay((r) => r.method === "GET" && r.path.endsWith("/worklog"), 150);

    await openApp(page, jira, { waitFor: "PRJ-1" });
    await expect.poll(async () => (await idbAll(page, "workLogs")).length).toBe(12 * 25);

    expect(jira.peakConcurrency("worklog-list")).toBeLessThanOrEqual(4);
    expect(jira.peakConcurrency("worklog-list")).toBeGreaterThanOrEqual(2); // still parallel
  });

  test("negative: the limit does not drop any issue's worklogs", async ({ page }) => {
    const jira = new FakeJira();
    manyLongTickets(jira, 9);
    jira.delay((r) => r.method === "GET" && r.path.endsWith("/worklog"), 50);

    await openApp(page, jira, { waitFor: "PRJ-1" });
    await expect.poll(async () => (await idbAll(page, "workLogs")).length).toBe(9 * 25);
    for (let i = 1; i <= 9; i++) {
      expect(await worklogCount(page, `PRJ-${i}`)).toBe(25);
    }
  });
});
