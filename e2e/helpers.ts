import { expect, type Locator, type Page } from "@playwright/test";
import type { FakeJira } from "./fake-jira";
import type { E2EState } from "./shims/state";

export const ACCOUNT_ID = "acc1";

export interface SeedAccount {
  id: string;
  name: string;
  instanceUrl: string;
  email: string;
  apiToken: string;
}

export function accountFor(jira: FakeJira, overrides: Partial<SeedAccount> = {}): SeedAccount {
  return {
    id: ACCOUNT_ID,
    name: "Acme",
    instanceUrl: jira.baseUrl,
    email: "me@acme.test",
    apiToken: "test-token",
    ...overrides,
  };
}

export interface OpenAppOptions {
  accounts?: SeedAccount[];
  /** Wait until this issue key is visible in the table. `null` skips waiting. */
  waitFor?: string | null;
  /** Extra Jira servers to attach (multi-account tests). */
  otherJira?: FakeJira[];
  /** Extra localStorage entries, written on first load only. */
  storage?: Record<string, string>;
}

/**
 * Opens the app against `jira`. The account (and any extra storage) is seeded once, on the
 * first load, so a later page.reload() keeps whatever the app has persisted itself.
 */
export async function openApp(
  page: Page,
  jira: FakeJira | null,
  options: OpenAppOptions = {},
): Promise<void> {
  const accounts = options.accounts ?? (jira ? [accountFor(jira)] : []);
  await page.addInitScript(
    ([seed, storage]) => {
      if (localStorage.getItem("jira-accounts")) return;
      if (seed.length > 0) localStorage.setItem("jira-accounts", JSON.stringify(seed));
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    },
    [accounts, options.storage ?? {}] as const,
  );
  if (jira) await jira.attach(page);
  for (const other of options.otherJira ?? []) await other.attach(page);
  await page.goto("/");
  if (options.waitFor !== null && options.waitFor !== undefined) {
    await expect(row(page, options.waitFor)).toBeVisible();
  }
}

export function row(page: Page, key: string): Locator {
  return page.getByRole("row").filter({ hasText: key }).first();
}

/** The labelled form control (Select trigger / input) inside the detail panel. */
export function field(panel: Locator, label: string): Locator {
  return panel
    .locator("div.space-y-1\\.5")
    .filter({ has: panel.page().locator("label", { hasText: new RegExp(`^${label}$`) }) })
    .first();
}

export function detailPanel(page: Page): Locator {
  return page.locator("div.animate-slide-in-right");
}

export async function openTask(page: Page, key: string): Promise<Locator> {
  await row(page, key).getByText(key, { exact: true }).click();
  const panel = detailPanel(page);
  await expect(panel.getByText(key, { exact: true }).first()).toBeVisible();
  return panel;
}

/** Radix <Select>: open the trigger and click an option by its visible text. */
export async function chooseOption(page: Page, trigger: Locator, optionText: string) {
  await trigger.click();
  await page.getByRole("option", { name: optionText, exact: true }).click();
}

export async function setSeverity(page: Page, panel: Locator, severity: string) {
  await chooseOption(page, field(panel, "Severity").getByRole("combobox"), severity);
}

export async function setStatus(page: Page, panel: Locator, status: string) {
  await chooseOption(page, field(panel, "Status").getByRole("combobox"), status);
}

export async function setType(page: Page, panel: Locator, type: string) {
  await chooseOption(page, field(panel, "Type").getByRole("combobox"), type);
}

export async function setNote(panel: Locator, text: string) {
  const note = panel.getByPlaceholder("Add a note...");
  await note.fill(text);
  await note.blur();
}

export async function setMandays(panel: Locator, text: string) {
  const input = panel.getByPlaceholder("e.g. 1d 4h 30m");
  await input.fill(text);
  await input.blur();
}

export async function logWork(page: Page, panel: Locator, time: string, comment?: string) {
  await panel.getByRole("button", { name: "Log Time" }).click();
  await page.getByPlaceholder("e.g. 1d 2h 30m").fill(time);
  if (comment) await page.getByPlaceholder("What did you work on?").fill(comment);
  await page.getByRole("button", { name: "Log Work", exact: true }).click();
}

export function syncButton(page: Page): Locator {
  return page.locator("header").getByRole("button", { name: "Sync", exact: true });
}

export function pushButton(page: Page): Locator {
  return page.locator("header").getByRole("button", { name: /Push \d+ change/ });
}

export function toasts(page: Page): Locator {
  return page.locator("[aria-label^='Notifications (F8)'] li");
}

/** Click Sync and wait until the request reached Jira and the sync settled. */
export async function pullFromJira(page: Page, jira: FakeJira) {
  const before = jira.find("POST", "search/jql").length;
  await syncButton(page).click();
  await expect.poll(() => jira.find("POST", "search/jql").length).toBeGreaterThan(before);
  await expect(syncButton(page)).toBeEnabled();
}

/** Click the header push button and wait for the push to finish. */
export async function pushAll(page: Page) {
  await pushButton(page).click();
}

export async function idbAll<T = Record<string, unknown>>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (storeName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("jira-task-manager");
      open.onerror = () => reject(new Error(open.error?.message ?? "IndexedDB open failed"));
      open.onsuccess = () => resolve(open.result);
    });
    const rows = await new Promise<T[]>((resolve, reject) => {
      const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      req.onerror = () => reject(new Error(req.error?.message ?? "IndexedDB read failed"));
      req.onsuccess = () => resolve(req.result as T[]);
    });
    db.close();
    return rows;
  }, store);
}

export async function idbPut(page: Page, store: string, value: unknown): Promise<void> {
  await page.evaluate(
    async ([storeName, record]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("jira-task-manager");
        open.onerror = () => reject(new Error(open.error?.message ?? "IndexedDB open failed"));
        open.onsuccess = () => resolve(open.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(record);
        tx.onerror = () => reject(new Error(tx.error?.message ?? "IndexedDB write failed"));
        tx.oncomplete = () => resolve();
      });
      db.close();
    },
    [store, value] as const,
  );
}

export async function getTask(page: Page, key: string) {
  const tasks = await idbAll<Record<string, unknown>>(page, "tasks");
  return tasks.find((t) => t.jiraTaskId === key);
}

export async function readE2EState(page: Page): Promise<E2EState> {
  return page.evaluate(() => window.__e2e ?? { files: {}, opened: [], savePath: null });
}
