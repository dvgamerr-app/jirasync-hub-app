import { expect, type Page } from "@playwright/test";
import { test } from "@playwright/test";
import { FakeJira } from "./fake-jira";
import { readE2EState, openApp } from "./helpers";
import type { E2EHarnessState } from "./shims/state";
import type { DoctorReport, RepoAnalysis, RepoBinding, RepoDetection } from "@/lib/harness";

const PROJECT_ID = "proj-acc1-PRJ";
const REPO = "C:\\src\\service";

function report(overrides: { claudeBroken?: boolean } = {}): DoctorReport {
  const tool = (name: string, required: boolean, ok = true) => ({
    name,
    required,
    purpose: `${name} purpose`,
    path: `C:/tools/${name}.exe`,
    version: ok ? `${name} 1.0.0` : null,
    ok,
    detail: ok ? null : "found but could not start: exit code 1",
  });
  const claudeOk = !overrides.claudeBroken;
  return {
    tools: [
      tool("git", true),
      tool("claude", true, claudeOk),
      tool("gh", true),
      tool("hurl", false),
    ],
    docker: {
      context: "wsl2",
      endpoint: "tcp://127.0.0.1:49878",
      serverVersion: "27.1",
      ok: true,
      detail: null,
    },
    ready: claudeOk,
    checkedAt: 0,
  };
}

const detection: RepoDetection = {
  root: "C:/src/service",
  remoteUrl: "git@github.com:acme/service.git",
  defaultBranch: "main",
  ecosystem: "bun",
  commands: {
    install: { executable: "bun", args: ["install", "--frozen-lockfile"] },
    test: { executable: "bun", args: ["run", "test"] },
    dev: { executable: "bun", args: ["run", "dev"] },
  },
  envFiles: [".env", ".env.test"],
  envExampleFile: ".env.example",
  missingEnvKeys: ["REDIS_URL"],
  serviceEnvKeys: ["DATABASE_URL", "REDIS_URL"],
  composeFiles: ["docker-compose.yml"],
  notes: [],
  missingExecutables: [],
  services: [],
  envOverrides: [],
};

async function seedHarness(page: Page, harness: Partial<E2EHarnessState>, openPath?: string) {
  await page.addInitScript(
    ([seed, folder]) => {
      window.__e2e = {
        files: {},
        opened: [],
        savePath: null,
        openPath: folder ?? null,
        harness: {
          doctor: seed.doctor!,
          detections: seed.detections ?? {},
          analyses: seed.analyses ?? {},
          bindings: seed.bindings ?? [],
          calls: [],
        },
      };
    },
    [harness, openPath ?? null] as const,
  );
}

async function openBoard(page: Page) {
  const jira = new FakeJira();
  jira.addIssue({ key: "PRJ-1", summary: "Board work" });
  await openApp(page, jira, { waitFor: "PRJ-1" });
  await page.getByRole("link", { name: "AI Board", exact: true }).click();
  await expect(page.getByTestId("ai-board")).toBeVisible();
}

const harnessCalls = async (page: Page) =>
  (await readE2EState(page)).harness?.calls.map((call) => call.cmd) ?? [];

test("first AI Board visit opens Setup when a required tool cannot start, only once", async ({
  page,
}) => {
  await seedHarness(page, { doctor: report({ claudeBroken: true }) });
  await openBoard(page);

  const dialog = page.getByRole("dialog", { name: "Agent setup" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(
    "Fix the required tools below before running an agent.",
  );
  const claude = dialog.getByRole("listitem", { name: "Tool claude" });
  await expect(claude).toContainText("Required");
  await expect(claude).toContainText("found but could not start: exit code 1");
  await expect(dialog.getByRole("listitem", { name: "Tool docker" })).toContainText(
    "tcp://127.0.0.1:49878",
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Agent setup" })).toHaveAttribute(
    "title",
    "A required tool is not ready",
  );

  // Second visit: the owner already saw it, so it does not pop up again.
  await page.reload();
  await expect(page.getByTestId("ai-board")).toBeVisible();
  await expect(page.getByRole("button", { name: "Agent setup" })).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(await harnessCalls(page)).not.toContain("harness_doctor");
});

test("first AI Board visit stays quiet when every required tool works", async ({ page }) => {
  await seedHarness(page, { doctor: report() });
  await openBoard(page);

  await expect.poll(() => harnessCalls(page)).toContain("harness_doctor");
  await expect(page.getByRole("dialog", { name: "Agent setup" })).toBeHidden();

  await page.getByRole("button", { name: "Agent setup" }).click();
  await expect(page.getByRole("dialog", { name: "Agent setup" }).getByRole("status")).toHaveText(
    "All required tools work. The agent can run on this machine.",
  );
});

const analysis: RepoAnalysis = {
  summary: "bun monorepo: api + web",
  commands: {
    install: { executable: "bun", args: ["install", "--frozen-lockfile"] },
    test: { executable: "bun", args: ["--cwd", "api", "run", "test"] },
  },
  services: [],
  copyEnv: ["api/.env"],
  envOverrides: [],
  notes: [],
};

const withServices: RepoAnalysis = {
  ...analysis,
  commands: { ...analysis.commands, migrate: { executable: "bun", args: ["run", "db:migrate"] } },
  services: [
    { name: "db", image: "postgres:16", port: 5432, env: [], healthcheck: ["CMD", "pg_isready"] },
    { name: "cache", image: "redis:7", port: 6379, env: [], healthcheck: [] },
  ],
  envOverrides: [
    { key: "DATABASE_URL", value: "postgres://app:app@{services.db.host}:{services.db.port}/app" },
  ],
};

async function openRepoEditor(page: Page) {
  await page.getByRole("button", { name: "Agent setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Agent setup" });
  await dialog.getByRole("tab", { name: "repositories" }).click();
  await dialog.getByRole("button", { name: "Acme: Project PRJ" }).click();
  return dialog;
}

test("binding a repo saves what the AI worked out, with the base branch from GitHub", async ({
  page,
}) => {
  await seedHarness(
    page,
    {
      doctor: report(),
      detections: { [REPO]: detection },
      analyses: { "C:/src/service": analysis },
    },
    REPO,
  );
  await openBoard(page);
  await page.getByRole("button", { name: "Agent setup" }).click();
  const dialog = page.getByRole("dialog", { name: "Agent setup" });
  await dialog.getByRole("tab", { name: "repositories" }).click();
  const project = dialog.getByRole("button", { name: "Acme: Project PRJ" });
  await expect(project).toContainText("Not bound");
  await project.click();

  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(dialog.getByText("bun monorepo: api + web")).toBeVisible();
  await expect(dialog.getByText("Missing from .env (in .env.example): REDIS_URL")).toBeVisible();
  await expect(dialog.getByLabel("Repository folder")).toHaveValue("C:/src/service");
  await expect(dialog.getByLabel("Base branch")).toContainText("main");
  await expect(dialog.getByLabel("Worktree folder")).toHaveText("C:\\wt");
  // Commands are not shown: they are saved to a config file next to the worktrees instead.
  await expect(dialog.getByText("bun --cwd api run test")).toHaveCount(0);
  await expect(dialog.getByText(/.config.json/)).toBeVisible();
  // Nothing about the setup is typed by hand any more.
  await expect(dialog.getByRole("textbox")).toHaveCount(1);

  await dialog.getByRole("button", { name: "Save repository" }).click();
  await expect(project).toContainText("Bound");
  await expect(project).not.toContainText("Not bound");

  const saved = (await readE2EState(page)).harness?.bindings ?? [];
  expect(saved).toHaveLength(1);
  const binding: RepoBinding = saved[0];
  expect(binding).toMatchObject({
    projectId: PROJECT_ID,
    repoPath: "C:/src/service",
    baseBranch: "main",
    worktreeRoot: "C:\\wt",
    copyEnv: ["api/.env"],
  });
  expect(binding.commands.test).toEqual({
    executable: "bun",
    args: ["--cwd", "api", "run", "test"],
  });
  expect(binding.commands.lint ?? null).toBeNull();
  expect(await harnessCalls(page)).toContain("harness_analyze_repo");
});

test("when the AI pass fails the guess from the repo files is kept and the reason shown", async ({
  page,
}) => {
  await seedHarness(
    page,
    {
      doctor: report(),
      detections: { [REPO]: detection },
      analyses: { "C:/src/service": "claude failed (exit code 1: Not logged in)" },
    },
    REPO,
  );
  await openBoard(page);
  const dialog = await openRepoEditor(page);
  await dialog.getByRole("button", { name: "Browse" }).click();

  await expect(dialog.getByText(/AI analysis failed \(claude failed/)).toBeVisible();
  await expect(dialog.getByText("Detected bun")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save repository" })).toBeEnabled();
});

test("a folder that is not a git repo shows why and saves nothing", async ({ page }) => {
  await seedHarness(page, {
    doctor: report(),
    detections: {
      "C:\Users\me\Downloads": "C:\Users\me\Downloads is not inside a git repository",
    },
  });
  await openBoard(page);
  const dialog = await openRepoEditor(page);

  await dialog.getByLabel("Repository folder").fill("C:\Users\me\Downloads");
  await dialog.getByRole("button", { name: "Analyze" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "C:\Users\me\Downloads is not inside a git repository",
  );
  await expect(dialog.getByRole("button", { name: "Save repository" })).toBeDisabled();
  expect(await harnessCalls(page)).not.toContain("harness_analyze_repo");
  expect(await harnessCalls(page)).not.toContain("harness_save_binding");
  expect((await readE2EState(page)).harness?.bindings).toEqual([]);
});

test("removing a binding asks first and keeps it when the owner backs out", async ({ page }) => {
  const existing: RepoBinding = {
    projectId: PROJECT_ID,
    repoPath: "C:/src/service",
    baseBranch: "develop",
    worktreeRoot: "D:\wt",
    commands: { test: { executable: "npm", args: ["test"] } },
    copyEnv: [".env"],
    services: [],
    envOverrides: [],
    updatedAt: 1,
  };
  await seedHarness(page, { doctor: report(), bindings: [existing] });
  await openBoard(page);
  const dialog = await openRepoEditor(page);
  const project = dialog.getByRole("button", { name: "Acme: Project PRJ" });
  await expect(project).toContainText("Bound");
  await expect(project).not.toContainText("Not bound");
  await expect(dialog.getByLabel("Base branch")).toContainText("develop");

  await dialog.getByRole("button", { name: "Remove binding" }).click();
  await dialog.getByRole("button", { name: "Keep" }).click();
  expect((await readE2EState(page)).harness?.bindings).toHaveLength(1);

  await dialog.getByRole("button", { name: "Remove binding" }).click();
  await dialog.getByRole("button", { name: "Confirm remove" }).click();
  await expect(project).toContainText("Not bound");
  expect((await readE2EState(page)).harness?.bindings).toEqual([]);
});

test("AI-proposed services, per-run env values and migrations are saved with the binding", async ({
  page,
}) => {
  await seedHarness(
    page,
    {
      doctor: report(),
      detections: { [REPO]: detection },
      analyses: { "C:/src/service": withServices },
    },
    REPO,
  );
  await openBoard(page);
  const dialog = await openRepoEditor(page);
  await dialog.getByRole("button", { name: "Browse" }).click();

  await dialog.getByRole("button", { name: "Save repository" }).click();
  await expect(dialog.getByRole("button", { name: "Acme: Project PRJ" })).toContainText("Bound");

  const [saved] = (await readE2EState(page)).harness?.bindings ?? [];
  expect(saved.services.map((service) => [service.name, service.image])).toEqual([
    ["db", "postgres:16"],
    ["cache", "redis:7"],
  ]);
  expect(saved.envOverrides).toEqual(withServices.envOverrides);
  expect(saved.commands.migrate).toEqual({ executable: "bun", args: ["run", "db:migrate"] });
});
