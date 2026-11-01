import { expect, test } from "@playwright/test";
import { adfParagraph, FakeJira } from "./fake-jira";
import { accountFor, getTask, idbAll, openApp, openTask, row, setNote } from "./helpers";

function boardJira() {
  const jira = new FakeJira();
  jira.statuses = ["To Do", "In Progress", "In Review", "Done"];
  return jira;
}

test("board is a separate page and returning keeps the original task layout and filters", async ({
  page,
}) => {
  const jira = boardJira();
  jira.addIssue({ key: "PRJ-1", summary: "Pending work" });
  jira.addIssue({ key: "PRJ-2", summary: "Completed work", status: "Done" });
  await page.route("**/schema-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Schema fixture</title>",
    }),
  );
  await page.goto("/schema-fixture");
  await page.evaluate(async () => {
    // Dexie v2 is native IndexedDB version 20; seed the previous schema before loading the app.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("jira-task-manager", 20);
      request.onupgradeneeded = () => {
        for (const name of ["organizations", "projects", "tasks", "workLogs", "syncMeta"])
          request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("tasks", "readwrite");
      transaction.objectStore("tasks").put({
        id: "task-acc1-PRJ-1",
        projectId: "proj-acc1-PRJ",
        jiraTaskId: "PRJ-1",
        note: "Legacy handoff survives upgrade",
        isDirty: false,
        isSynced: true,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await openApp(page, jira, {
    waitFor: "PRJ-1",
    accounts: [accountFor(jira, { name: "SCG Digital Office" })],
  });
  expect((await getTask(page, "PRJ-1"))?.note).toBe("Legacy handoff survives upgrade");
  expect(await idbAll(page, "aiBoardStates")).toHaveLength(1);
  await page.locator("header").getByRole("button", { name: "Done", exact: true }).click();
  await expect(row(page, "PRJ-2")).toBeVisible();
  const oldPanel = await openTask(page, "PRJ-2");
  await expect(oldPanel.getByRole("button", { name: "Copy for AI", exact: true })).toHaveCount(0);
  await expect(
    oldPanel.getByRole("button", { name: "Summarize to Jira", exact: true }),
  ).toHaveCount(0);
  await setNote(oldPanel, "Keep existing detail and note");
  const orgPosition = await page
    .getByRole("button", { name: "SCG Digital Office", exact: true })
    .boundingBox();
  const projectPosition = await page
    .locator("aside")
    .getByRole("button", { name: "Project PRJ PRJ", exact: true })
    .boundingBox();
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await expect(page).toHaveURL(/#\/ai-board$/);
  await expect(page.getByTestId("ai-board")).toBeVisible();
  const organization = page.getByRole("button", { name: "SCG Digital Office", exact: true });
  const project = page.getByRole("button", {
    name: "SCG Digital Office: Project PRJ",
    exact: true,
  });
  expect(await organization.boundingBox()).toEqual(orgPosition);
  expect(await project.boundingBox()).toEqual(projectPosition);
  await organization.click();
  await expect(project).toBeHidden();
  await organization.click();
  await expect(project).toBeVisible();
  expect(await organization.boundingBox()).toEqual(orgPosition);
  await expect(page.getByRole("region", { name: "Task board", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "PRJ-1: Pending work", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "PRJ-2: Completed work", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All projects 1", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "My Work", exact: true }).click();
  expect(
    await page.getByRole("button", { name: "SCG Digital Office", exact: true }).boundingBox(),
  ).toEqual(orgPosition);
  await expect(row(page, "PRJ-2")).toBeVisible();
  await expect(row(page, "PRJ-1")).toHaveCount(0);
  await expect(
    page.locator("header").getByRole("button", { name: "Done", exact: true }),
  ).toHaveClass(/bg-background/);
  await expect(page.getByPlaceholder("Add a note...")).toHaveValue("Keep existing detail and note");
  await page.goto("/#/ai-board");
  await expect(
    page.getByRole("button", { name: "PRJ-1: Pending work", exact: true }),
  ).toBeVisible();
});

test("space visibility persists independently of Jira while project search and theme still work", async ({
  page,
}) => {
  const jira = boardJira();
  jira.addIssue({
    key: "ALPHA-1",
    summary: "Alpha work",
    description: adfParagraph("Unique API Context"),
  });
  jira.addIssue({ key: "BETA-1", summary: "Beta work" });
  await openApp(page, jira, { waitFor: "ALPHA-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await page.getByRole("button", { name: "Acme: Project ALPHA", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Project ALPHA" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "ALPHA-1: Alpha work", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "BETA-1: Beta work", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /All projects/ }).click();
  const search = page.getByLabel("Search board");
  await expect(page.locator(".board-toolbar").getByLabel("Search board")).toBeVisible();
  await expect(page.locator(".board-sidebar input")).toHaveCount(0);
  await search.fill("unique api");
  await expect(
    page.getByRole("button", { name: "ALPHA-1: Alpha work", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "BETA-1: Beta work", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+f");
  await expect(search).toBeFocused();
  expect(
    await search.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!),
  ).toBe(10);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).not.toBeFocused();
  await search.fill("alpha");
  await page.getByRole("button", { name: "Clear board search" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(page.getByRole("button", { name: "BETA-1: Beta work", exact: true })).toBeVisible();
  const assertTheme = async () => {
    expect(
      await page.evaluate(() => {
        const board = document.querySelector<HTMLElement>(".ai-board")!;
        const probe = document.createElement("div");
        probe.style.backgroundColor = "hsl(var(--background))";
        board.append(probe);
        const matches =
          getComputedStyle(board).backgroundColor === getComputedStyle(probe).backgroundColor;
        probe.remove();
        return matches;
      }),
    ).toBe(true);
  };
  await assertTheme();
  const themeButton = page
    .locator(".board-toolbar")
    .getByRole("button", { name: /Switch to .* theme/ });
  await expect(themeButton).toBeVisible();
  await expect(page.locator(".board-sidebar-footer button")).toHaveCount(0);
  const themeBefore = await page.locator("html").getAttribute("class");
  await themeButton.click();
  expect(await page.locator("html").getAttribute("class")).not.toBe(themeBefore);
  await assertTheme();
  await page.getByRole("button", { name: "Acme: Project ALPHA", exact: true }).click();
  await page.getByRole("button", { name: "ALPHA-1: Alpha work", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Board details ALPHA-1" })).toBeVisible();
  const projectRow = page
    .locator(".board-project-row")
    .filter({ has: page.getByRole("button", { name: "Acme: Project ALPHA", exact: true }) });
  await page.locator("h1").hover();
  await expect(projectRow.locator(".board-project-folder")).toBeVisible();
  await expect(projectRow.locator(".board-project-eye")).toBeHidden();
  await projectRow.hover();
  await expect(projectRow.locator(".board-project-folder")).toBeHidden();
  await expect(projectRow.locator(".board-project-eye")).toBeVisible();
  const hide = page.getByRole("button", { name: "Hide Acme: Project ALPHA", exact: true });
  const hideBox = await hide.boundingBox();
  const rowBox = await projectRow.boundingBox();
  expect(hideBox!.x - rowBox!.x).toBe(10);
  await hide.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Project ALPHA", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Board details ALPHA-1" })).toBeVisible();
  await page.getByRole("button", { name: /All projects/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "All projects", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "ALPHA-1: Alpha work", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("complementary", { name: "Board details ALPHA-1" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "BETA-1: Beta work", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All projects 1", exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Show Acme: Project ALPHA", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "ALPHA-1: Alpha work", exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "My Work", exact: true }).click();
  await expect(row(page, "ALPHA-1")).toBeVisible();
  await expect(row(page, "BETA-1")).toBeVisible();
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await page.getByRole("button", { name: "Show Acme: Project ALPHA", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "All projects", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "ALPHA-1: Alpha work", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "All projects 2", exact: true })).toBeVisible();
  expect((await getTask(page, "ALPHA-1"))?.isDirty).toBe(false);
});

test("AI progress persists independently of Jira, including offline AI completion", async ({
  page,
  context,
}) => {
  const jira = boardJira();
  jira.addIssue({
    key: "PRJ-1",
    summary: "Move this task",
    status: "In Progress",
    blockedStatuses: ["In Review", "Done"],
  });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  const card = page.getByRole("button", { name: "PRJ-1: Move this task", exact: true });
  await expect(
    page
      .getByRole("region", { name: "To Do column", exact: true })
      .getByRole("button", { name: "PRJ-1: Move this task", exact: true }),
  ).toBeVisible();
  await card.dragTo(page.getByRole("region", { name: "Doing column", exact: true }));
  await expect(
    page
      .getByRole("region", { name: "Doing column", exact: true })
      .getByRole("button", { name: "PRJ-1: Move this task", exact: true }),
  ).toBeVisible();
  expect((await getTask(page, "PRJ-1"))?.status).toBe("In Progress");
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  await expect.poll(async () => (await idbAll(page, "aiBoardStates"))[0]?.status).toBe("doing");
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Doing column", exact: true })
      .getByRole("button", { name: "PRJ-1: Move this task", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync board" })).toBeEnabled();
  await context.setOffline(true);
  await card.dragTo(page.getByRole("region", { name: "Done column", exact: true }));
  await expect(
    page
      .getByRole("region", { name: "Done column", exact: true })
      .getByRole("button", { name: "PRJ-1: Move this task", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await idbAll(page, "aiBoardStates"))[0]?.status).toBe("done");
  expect((await getTask(page, "PRJ-1"))?.status).toBe("In Progress");
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  expect(jira.find("PUT", "issue/PRJ-1")).toHaveLength(0);
  expect(jira.find("GET", "issue/PRJ-1/transitions")).toHaveLength(0);
  expect(jira.find("POST", "issue/PRJ-1/transitions")).toHaveLength(0);
  expect(jira.issues.get("PRJ-1")?.status).toBe("In Progress");
  await expect(page.getByRole("button", { name: /^Push/ })).toHaveCount(0);
});

test("Jira completion closes AI work in one direction and reopening Jira does not reset AI progress", async ({
  page,
}) => {
  const jira = boardJira();
  jira.statuses = ["Open", "QA", "Resolved"];
  const issue = jira.addIssue({ key: "PRJ-1", summary: "Human and AI workflows", status: "QA" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  const card = page.getByRole("button", { name: "PRJ-1: Human and AI workflows", exact: true });
  await expect(page.getByRole("region", { name: "QA column", exact: true })).toHaveCount(0);
  await card.dragTo(page.getByRole("region", { name: "Review column", exact: true }));
  await expect.poll(async () => (await idbAll(page, "aiBoardStates"))[0]?.status).toBe("review");
  await card.click();
  await expect(page.getByLabel("AI task status")).toHaveText("Review");
  issue.status = "Resolved";
  await page.getByRole("button", { name: "Sync board" }).click();
  await expect.poll(async () => (await idbAll(page, "aiBoardStates"))[0]?.jiraDone).toBe(true);
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Board details PRJ-1" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "All projects 0", exact: true })).toBeVisible();
  expect((await getTask(page, "PRJ-1"))?.status).toBe("Resolved");
  expect((await idbAll(page, "aiBoardStates"))[0]?.status).toBe("done");
  issue.status = "Open";
  await expect(page.getByRole("button", { name: "Sync board" })).toBeEnabled();
  await page.getByRole("button", { name: "Sync board" }).click();
  await expect.poll(async () => (await idbAll(page, "aiBoardStates"))[0]?.jiraDone).toBe(false);
  await expect(
    page
      .getByRole("region", { name: "Done column", exact: true })
      .getByRole("button", { name: "PRJ-1: Human and AI workflows", exact: true }),
  ).toBeVisible();
  await card.click();
  await expect(page.getByLabel("AI task status")).toHaveText("Done");
  await expect(page.getByLabel("AI task status")).toBeEnabled();
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  expect(jira.find("POST", "issue/PRJ-1/transitions")).toHaveLength(0);
});

test("board detail supports offline context and handoff, summary drafts, and a small window", async ({
  page,
  context,
}) => {
  const jira = boardJira();
  jira.addIssue({
    key: "PRJ-1",
    summary: "Work with AI",
    description: adfParagraph("Original API Description"),
  });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await page.getByRole("button", { name: "PRJ-1: Work with AI", exact: true }).click();
  const detail = page.getByRole("complementary", { name: "Board details PRJ-1" });
  await expect(detail.getByText("Original API Description", { exact: true })).toBeVisible();
  await detail.getByLabel("Board handoff").fill("Local checkpoint");
  await detail.getByRole("button", { name: "Insert handoff template", exact: true }).click();
  await expect
    .poll(async () => (await getTask(page, "PRJ-1"))?.note)
    .toContain("Local checkpoint\n\n## Done");
  expect((await getTask(page, "PRJ-1"))?.isDirty).toBe(false);
  await detail.getByRole("button", { name: "Summarize to Jira", exact: true }).click();
  await page.getByLabel("Summary", { exact: true }).fill("Keep board summary");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 600 });
  const box = await detail.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1000);
  await detail.getByRole("button", { name: "Copy for AI", exact: true }).click();
  await expect(page.getByLabel("AI context preview")).toHaveValue(/Original API Description/);
  await expect(page.getByLabel("AI context preview")).not.toHaveValue(/Local checkpoint/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await context.setOffline(true);
  await detail.getByRole("button", { name: "Summarize to Jira", exact: true }).click();
  await expect(page.getByLabel("Summary", { exact: true })).toHaveValue("Keep board summary");
  expect(jira.find("POST", "issue/PRJ-1/comment")).toHaveLength(0);
});
