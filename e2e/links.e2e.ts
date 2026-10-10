import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, openTask } from "./helpers";

function linkedDescription() {
  const text = (value: string, href?: string) => ({
    type: "text",
    text: value,
    ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}),
  });
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          text("Docs", "https://docs.example.com/guide"),
          text(" · "),
          text("Mail", "mailto:team@example.com"),
          text(" · "),
          text("Bad", "javascript:window.__pwned=1"),
          text(" · "),
          text("Local", "file:///C:/Windows/System32/calc.exe"),
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "inlineCard", attrs: { url: "https://example.com/card" } },
          { type: "inlineCard", attrs: { url: "javascript:window.__pwned=2" } },
        ],
      },
    ],
  };
}

// Outside Tauri `openExternal` falls back to window.open; record those calls instead of opening tabs.
async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
}

async function openDescription(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = (url) => {
      w.__opened.push(String(url));
      return null;
    };
  });
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", summary: "Has links", description: linkedDescription() });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  const panel = await openTask(page, "PRJ-1");
  await panel.getByRole("button", { name: "Show Description" }).click();
  return panel;
}

test.describe("links in a ticket description", () => {
  test("positive: http(s) and mailto links are handed to the system opener, not navigated in-app", async ({
    page,
  }) => {
    const panel = await openDescription(page);
    const urlBefore = page.url();

    await panel.getByRole("link", { name: "Docs" }).click();
    await panel.getByRole("link", { name: "Mail" }).click();
    await panel.getByRole("link", { name: "https://example.com/card" }).click();

    await expect
      .poll(() => openedUrls(page))
      .toEqual([
        "https://docs.example.com/guide",
        "mailto:team@example.com",
        "https://example.com/card",
      ]);
    expect(page.url()).toBe(urlBefore);
  });

  test("negative: javascript: and file: links are plain text and do nothing", async ({ page }) => {
    const panel = await openDescription(page);

    await expect(panel.getByRole("link", { name: "Bad" })).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Local" })).toHaveCount(0);
    // the words stay readable, they just are not links
    await expect(panel.getByText(/Bad · Local/)).toBeVisible();
    await expect(panel.locator('a[href^="javascript"], a[href^="file"]')).toHaveCount(0);
    await panel.getByText("javascript:window.__pwned=2").click();

    const pwned = await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned);
    expect(pwned).toBeUndefined();
    expect(await openedUrls(page)).toEqual([]);
  });
});
