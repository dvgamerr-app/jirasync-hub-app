import { expect, test, type Page } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { openApp, openTask, pushButton, setSeverity, syncButton } from "./helpers";

test.describe("the app is usable at the new minimum window size (1000x600)", () => {
  test.use({ viewport: { width: 1000, height: 600 } });

  async function setup(page: Page) {
    const jira = new FakeJira();
    jira.addIssue({ key: "PRJ-1", summary: "A reasonably long ticket title to stress the layout" });
    await openApp(page, jira, { waitFor: "PRJ-1" });
    const panel = await openTask(page, "PRJ-1");
    await setSeverity(page, panel, "High");
    return panel;
  }

  test("positive: header actions and the detail panel controls stay inside the window", async ({
    page,
  }) => {
    const panel = await setup(page);

    for (const button of [
      syncButton(page),
      pushButton(page),
      page.getByRole("button", { name: "Export", exact: true }),
    ]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(1000);
      expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    }

    const logTime = panel.getByRole("button", { name: "Log Time" });
    await logTime.scrollIntoViewIfNeeded();
    const box = await logTime.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(1000);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  });

  test("negative: the page itself never scrolls sideways or vertically", async ({ page }) => {
    await setup(page);

    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
  });
});
