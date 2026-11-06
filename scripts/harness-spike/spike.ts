// Phase 0 spike: drive the real Claude Code CLI the way the harness will.
// Usage: bun scripts/harness-spike/spike.ts <empty-work-dir> [--model haiku] [--skip-stop]
// Spends real tokens (capped by --max-budget-usd). See docs/agent-execution-harness-plan.md.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(root) && readdirSync(root).length)) {
  throw new Error("pass an empty (or missing) work directory as the first argument");
}
const model = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "haiku";
const skipStop = process.argv.includes("--skip-stop");
const bun = process.execPath;
const claude = Bun.which("claude");
if (!claude) throw new Error("claude CLI not found on PATH");

const skillsDir = resolve(import.meta.dir, "../../src-tauri/resources/harness-skills");
const mcpScript = resolve(import.meta.dir, "mcp-harness.ts");
const repo = join(root, "repo");
const worktree = join(root, "wt");
const runDir = join(root, "run");
mkdirSync(repo, { recursive: true });
mkdirSync(runDir, { recursive: true });

function sh(cmd: string[], cwd: string) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

// --- Fixture: a tiny repo with a failing test and an unimplemented endpoint ---------------
const files: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "fixture", private: true, scripts: { test: "bun test", dev: "bun server.ts" } },
    null,
    2,
  ),
  "src/sum.ts": `export function sum(a: number, b: number): number {\n  throw new Error("not implemented");\n}\n`,
  "src/sum.test.ts": `import { expect, test } from "bun:test";\nimport { sum } from "./sum";\n\ntest("sum", () => {\n  expect(sum(2, 3)).toBe(5);\n});\n`,
  "server.ts": `import { sum } from "./src/sum";\n\nBun.serve({\n  port: Number(process.env.PORT ?? 3000),\n  fetch(req) {\n    const url = new URL(req.url);\n    if (url.pathname === "/health") return new Response("ok");\n    if (url.pathname === "/api/sum") return new Response("not implemented", { status: 501 });\n    return new Response("not found", { status: 404 });\n  },\n});\n// keep import used\nvoid sum;\n`,
  ".gitignore": "node_modules\n.harness/\n",
};
for (const [path, content] of Object.entries(files)) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}
sh(["git", "init", "-q", "-b", "main"], repo);
sh(["git", "add", "."], repo);
sh(
  [
    "git",
    "-c",
    "user.name=spike",
    "-c",
    "user.email=spike@example.invalid",
    "commit",
    "-q",
    "-m",
    "chore: fixture",
  ],
  repo,
);
const baseSha = sh(["git", "rev-parse", "HEAD"], repo);
sh(["git", "worktree", "add", "-q", "-b", "ai/DEMO-1-spike", worktree, baseSha], repo);

// --- Harness MCP config ------------------------------------------------------------------
const devPort = 4300 + Math.floor(Math.random() * 500);
const journal = join(runDir, "journal.ndjson");
const commands = {
  test: { executable: bun, args: ["test"], timeoutMs: 120_000 },
  dev: { executable: bun, args: ["server.ts"], longRunning: true },
};
const mcpConfig = join(runDir, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      harness: {
        type: "stdio",
        command: bun,
        args: [mcpScript],
        env: {
          HARNESS_WORKTREE: worktree,
          HARNESS_JOURNAL: journal,
          HARNESS_LOG_DIR: join(runDir, "logs"),
          HARNESS_COMMANDS: JSON.stringify(commands),
          HARNESS_DEV_PORT: String(devPort),
          HARNESS_SKILLS_DIR: skillsDir,
        },
      },
    },
  }),
);

const prompt = [
  "Jira task DEMO-1: implement `sum` in src/sum.ts so the unit test passes,",
  'and make GET /api/sum?a=2&b=3 in server.ts return JSON {"result":5}.',
  "Verify with the harness: run the tests, start dev, and check the endpoint with a .hurl file.",
  "Finish with a short report.",
].join(" ");

function claudeArgs(sessionId: string, text: string) {
  return [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--tools",
    "Read,Glob,Grep,Edit,Write",
    // No built-in or personal skills: the only skills come from the app via MCP.
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--permission-mode",
    "acceptEdits",
    "--permission-prompt-tool",
    "mcp__harness__approve",
    "--append-system-prompt",
    "This is a JiraSync Hub harness run. Skills are provided by the JiraSync Hub app, not by Claude Code: call mcp__harness__skill_list, then load the `harness` skill with mcp__harness__skill_get before doing anything else and follow it. Load a skill's linked files with skill_get and its `file` argument.",
    "--model",
    model,
    "--max-budget-usd",
    "1",
    "--session-id",
    sessionId,
  ];
}

type StreamEvent = { type: string; subtype?: string; [key: string]: unknown };

async function runClaude(
  sessionId: string,
  text: string,
  onEvent?: (event: StreamEvent, proc: Bun.Subprocess) => void,
) {
  const events: StreamEvent[] = [];
  const proc = Bun.spawn([claude!, ...claudeArgs(sessionId, text)], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as StreamEvent;
      events.push(event);
      appendFileSync(join(runDir, `events-${sessionId}.ndjson`), line + "\n");
      onEvent?.(event, proc);
    }
  }
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { events, exitCode, stderr, pid: proc.pid };
}

const report: Record<string, unknown> = {
  model,
  claudeVersion: sh([claude, "--version"], root),
  baseSha,
};
const checks: { name: string; pass: boolean; detail?: unknown }[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, detail });
  const shown = detail === undefined ? "" : "  " + JSON.stringify(detail);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${shown}`);
};

// --- Run 1: full task ----------------------------------------------------------------------
const sessionId = crypto.randomUUID();
const startedAt = Date.now();
const run1 = await runClaude(sessionId, prompt, (event) => {
  if (event.type === "assistant") {
    const content = (event.message as { content: { type: string; name?: string; text?: string }[] })
      .content;
    for (const block of content) {
      if (block.type === "tool_use") console.log(`  tool_use ${block.name}`);
    }
  }
});
const wallMs = Date.now() - startedAt;
const init = run1.events.find((e) => e.type === "system" && e.subtype === "init") as
  StreamEvent | undefined;
const result = run1.events.find((e) => e.type === "result") as StreamEvent | undefined;
const tools = (init?.tools as string[]) ?? [];
report.init = {
  tools,
  mcp_servers: init?.mcp_servers,
  plugins: init?.plugins,
  skills: init?.skills,
  slash_commands: init?.slash_commands,
  permissionMode: init?.permissionMode,
};
report.result = result && {
  subtype: result.subtype,
  is_error: result.is_error,
  num_turns: result.num_turns,
  duration_ms: result.duration_ms,
  total_cost_usd: result.total_cost_usd,
  session_id: result.session_id,
};
if (run1.exitCode !== 0) report.stderr = run1.stderr.slice(-2000);

const toolUses = run1.events
  .filter((e) => e.type === "assistant")
  .flatMap((e) => (e.message as { content: { type: string; name?: string }[] }).content)
  .filter((b) => b.type === "tool_use")
  .map((b) => b.name);
const journalEntries = existsSync(journal)
  ? readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
  : [];
const execMs = journalEntries
  .filter((e) => e.event === "exec_end")
  .reduce((sum, e) => sum + (e.durationMs ?? 0), 0);

check("claude exited 0", run1.exitCode === 0, run1.exitCode);
check("session id is the one the app chose", result?.session_id === sessionId, result?.session_id);
check(
  "no shell tool available (Bash/PowerShell absent)",
  !tools.some((t) => /^(Bash|PowerShell)/.test(t)),
  tools.filter((t) => !t.startsWith("mcp__")),
);
check(
  "harness MCP server connected",
  JSON.stringify(init?.mcp_servers ?? "").includes('"connected"'),
  init?.mcp_servers,
);
check(
  "harness tools exposed",
  [
    "mcp__harness__run",
    "mcp__harness__git",
    "mcp__harness__get_log",
    "mcp__harness__skill_list",
    "mcp__harness__skill_get",
  ].every((t) => tools.includes(t)),
);
check(
  "no Claude Code skills loaded (built-in or personal)",
  ((init?.skills as string[]) ?? []).length === 0,
  init?.skills,
);
check(
  "agent loaded the harness skill from the app",
  journalEntries.some(
    (e) => e.event === "tool_call" && e.tool === "skill_get" && e.input?.name === "harness",
  ),
  journalEntries
    .filter((e) => e.tool === "skill_list" || e.tool === "skill_get")
    .map((e) => e.input),
);
check(
  "agent asked the app to run tests",
  journalEntries.some((e) => e.event === "exec_end" && e.name === "test"),
);
check(
  "agent asked the app to run hurl",
  journalEntries.some((e) => e.event === "exec_end" && e.name === "hurl"),
);
check(
  "last hurl run passed",
  journalEntries.filter((e) => e.event === "exec_end" && e.name === "hurl").at(-1)?.exitCode === 0,
);
check(
  "never tried a shell tool",
  !toolUses.some((n) => /^(Bash|PowerShell)/.test(n ?? "")),
  toolUses,
);

// Independent verification by the "app", not the agent's word.
const finalTest = Bun.spawnSync([bun, "test"], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
check("app re-runs tests independently: pass", finalTest.exitCode === 0, finalTest.exitCode);
check("agent did not commit", sh(["git", "rev-parse", "HEAD"], worktree) === baseSha);
check("base repo untouched", sh(["git", "status", "--porcelain"], repo) === "");
report.changedFiles = sh(["git", "status", "--porcelain"], worktree).split("\n");
report.budget = {
  wallMs,
  providerDurationMs: result?.duration_ms,
  appExecMs: execMs,
  aiActiveMsApprox: wallMs - execMs,
};

// --- Run 2: resume the same session -----------------------------------------------------------
const resume = Bun.spawnSync(
  [
    claude,
    "-p",
    "In one short sentence, what file did you change first?",
    "--resume",
    sessionId,
    "--output-format",
    "json",
    "--restricted",
    "--tools",
    "Read",
    "--strict-mcp-config",
    "--model",
    model,
    "--max-budget-usd",
    "0.2",
  ],
  { cwd: worktree, stdout: "pipe", stderr: "pipe" },
);
let resumed: { session_id?: string; result?: string } = {};
try {
  resumed = JSON.parse(resume.stdout.toString());
} catch {
  /* reported below */
}
check("resume by session id works", resume.exitCode === 0 && resumed.session_id === sessionId, {
  exit: resume.exitCode,
  session: resumed.session_id,
  answer: resumed.result?.slice(0, 160),
});

// --- Negative 1: --restricted confines file tools to the worktree --------------------------
const outside = join(root, "outside.txt");
const outsideRun = await runClaude(
  crypto.randomUUID(),
  `Use the Write tool once to create the file ${outside} containing "x". Do not try anything else.`,
);
const outsideDenials =
  (outsideRun.events.find((e) => e.type === "result")?.permission_denials as {
    tool_name: string;
  }[]) ?? [];
check(
  "deny: write outside worktree blocked",
  !existsSync(outside) && outsideDenials.some((d) => d.tool_name === "Write"),
);

// --- Negative 2: tool-config writes reach the app's handler and are denied -----------------
const settingsFile = join(worktree, ".claude", "settings.json");
const denyJournalStart = readFileSync(journal, "utf8").trim().split("\n").length;
await runClaude(
  crypto.randomUUID(),
  `Use the Write tool once to create .claude/settings.json containing {"hooks":{}}. Do not try anything else.`,
);
const denyEntries = readFileSync(journal, "utf8")
  .trim()
  .split("\n")
  .slice(denyJournalStart)
  .map((l) => JSON.parse(l));
check("deny: .claude/settings.json not written", !existsSync(settingsFile));
check(
  "deny: decided by the app's permission handler",
  denyEntries.some(
    (e) => e.event === "permission" && e.toolName === "Write" && e.decision === "deny",
  ),
  denyEntries.filter((e) => e.event === "permission"),
);

// --- Run 3: Stop kills the whole process tree -------------------------------------------------
if (!skipStop) {
  const stopJournalStart = journalEntries.length;
  const stopSession = crypto.randomUUID();
  let killedAt = 0;
  const stopRun = await runClaude(
    stopSession,
    "Run the tests with the harness, then start dev, then wait.",
    (event, proc) => {
      if (!killedAt && event.type === "assistant") {
        killedAt = Date.now();
        // Same as the native core: kill the tree, not only the parent.
        Bun.spawnSync(
          process.platform === "win32"
            ? ["taskkill", "/PID", String(proc.pid), "/T", "/F"]
            : ["kill", "-TERM", `-${proc.pid}`],
        );
      }
    },
  );
  await Bun.sleep(1500);
  const after = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .slice(stopJournalStart);
  const mcpPid = after.find((e) => e.event === "mcp_start")?.pid;
  const alive = (pid?: number) =>
    !!pid &&
    (process.platform === "win32"
      ? Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`])
          .stdout.toString()
          .includes(String(pid))
      : Bun.spawnSync(["kill", "-0", String(pid)]).exitCode === 0);
  check("stop: claude process gone", !alive(stopRun.pid), {
    pid: stopRun.pid,
    exitCode: stopRun.exitCode,
  });
  check("stop: MCP child gone", !alive(mcpPid), { mcpPid });
  let devAlive = false;
  try {
    await fetch(`http://127.0.0.1:${devPort}/health`, { signal: AbortSignal.timeout(1000) });
    devAlive = true;
  } catch {
    /* expected */
  }
  check("stop: dev server not left running", !devAlive, { devPort });
}

report.checks = checks;
writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nreport: ${join(runDir, "report.json")}`);
console.log(JSON.stringify(report.budget), JSON.stringify(report.result));
process.exit(checks.every((c) => c.pass) ? 0 : 1);
