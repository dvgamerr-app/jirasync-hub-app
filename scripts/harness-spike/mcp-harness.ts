// Phase 0 spike: minimal stdio MCP server standing in for the Rust harness core.
// Exposes `run`, `git`, `get_log`, `skill_list`, `skill_get`. Only commands named in
// HARNESS_COMMANDS can run; skills come only from HARNESS_SKILLS_DIR (bundled with the app);
// every call is appended to HARNESS_JOURNAL so the owner (and the spike) can see it.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

type CommandSpec = {
  executable: string;
  args: string[];
  timeoutMs?: number;
  longRunning?: boolean;
};

const worktree = process.env.HARNESS_WORKTREE!;
const journal = process.env.HARNESS_JOURNAL!;
const logDir = process.env.HARNESS_LOG_DIR!;
const commands: Record<string, CommandSpec> = JSON.parse(process.env.HARNESS_COMMANDS ?? "{}");
const devPort = Number(process.env.HARNESS_DEV_PORT ?? 0);
const skillsDir = process.env.HARNESS_SKILLS_DIR!;
const TAIL_LINES = 40;

function listSkills() {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => {
      const text = readFileSync(join(skillsDir, entry.name, "SKILL.md"), "utf8");
      return { name: entry.name, description: /^description:\s*(.+)$/m.exec(text)?.[1] ?? "" };
    });
}

function getSkill(input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  if (!listSkills().some((skill) => skill.name === name))
    return { status: "rejected", reason: `unknown skill "${name}"` };
  const skillRoot = join(skillsDir, name);
  const full = resolve(skillRoot, String(input.file ?? "SKILL.md"));
  const rel = relative(skillRoot, full);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(full))
    return { status: "rejected", reason: `no file "${input.file}" in skill ${name}` };
  return { name, file: rel.replaceAll("\\", "/"), content: readFileSync(full, "utf8") };
}

mkdirSync(logDir, { recursive: true });
let logSeq = 0;
let devProcess: ReturnType<typeof Bun.spawn> | undefined;

const record = (entry: Record<string, unknown>) =>
  appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

const tail = (text: string) => text.split(/\r?\n/).slice(-TAIL_LINES).join("\n");

async function execute(name: string, executable: string, args: string[], timeoutMs = 300_000) {
  const startedAt = Date.now();
  record({ event: "exec_start", name, executable, args });
  const proc = Bun.spawn([executable, ...args], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const logId = `log-${++logSeq}`;
  const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
  writeFileSync(join(logDir, `${logId}.log`), output);
  const durationMs = Date.now() - startedAt;
  record({ event: "exec_end", name, exitCode, durationMs, logId });
  return {
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs,
    logId,
    tail: tail(output),
  };
}

async function startDev() {
  const spec = commands.dev;
  if (!spec) return { status: "unavailable", reason: "no dev command in binding" };
  if (devProcess && devProcess.exitCode === null) return { status: "running", port: devPort };
  const startedAt = Date.now();
  record({ event: "exec_start", name: "dev", executable: spec.executable, args: spec.args });
  devProcess = Bun.spawn([spec.executable, ...spec.args], {
    cwd: worktree,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, PORT: String(devPort) },
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${devPort}/`);
      record({
        event: "exec_end",
        name: "dev",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        pid: devProcess.pid,
      });
      return { status: "running", port: devPort, baseUrl: `http://127.0.0.1:${devPort}` };
    } catch {
      await Bun.sleep(200);
    }
  }
  return { status: "failed", reason: "dev server did not answer within 10s" };
}

function hurlFiles(files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0)
    throw new Error("files: list of .hurl paths is required");
  return files.map((file) => {
    const full = resolve(worktree, String(file));
    const rel = relative(worktree, full);
    if (rel.startsWith("..") || isAbsolute(rel) || !full.endsWith(".hurl"))
      throw new Error(`not a .hurl file in the worktree: ${file}`);
    return full;
  });
}

const GIT_OPS: Record<string, string[]> = {
  status: ["status", "--short", "--branch"],
  diff: ["diff", "--stat", "--patch"],
  log: ["log", "--oneline", "-n", "20"],
  show: ["show", "--stat", "HEAD"],
};

// Permission handler for `--permission-prompt-tool mcp__harness__approve`: the app, not the
// agent, decides. `--restricted` already confines file tools to the worktree and sends writes
// to git/settings/tool-config files here; those stay denied so a run cannot add hooks or MCP.
const PROTECTED = [".git", ".claude", ".mcp.json"];
function approve(input: Record<string, unknown>) {
  const toolName = String(input.tool_name ?? "");
  const toolInput = (input.input ?? {}) as Record<string, unknown>;
  let allow = toolName.startsWith("mcp__harness__") && toolName !== "mcp__harness__approve";
  if (["Edit", "Write", "NotebookEdit"].includes(toolName)) {
    const rel = relative(worktree, resolve(worktree, String(toolInput.file_path ?? "")));
    const first = rel.split(/[\\/]/)[0];
    allow = !rel.startsWith("..") && !isAbsolute(rel) && !PROTECTED.includes(first);
  }
  record({ event: "permission", toolName, decision: allow ? "allow" : "deny" });
  return allow
    ? { behavior: "allow", updatedInput: toolInput }
    : {
        behavior: "deny",
        message: `${toolName} is not allowed in a harness run; use the harness tools`,
      };
}

async function callTool(name: string, input: Record<string, unknown>) {
  if (name === "approve") return approve(input);
  record({ event: "tool_call", tool: name, input });
  if (name === "run") {
    const command = String(input.command ?? "");
    if (command === "dev") return startDev();
    if (command === "hurl") {
      const hurl = Bun.which("hurl");
      if (!hurl) return { status: "unavailable", reason: "hurl is not installed" };
      const reportDir = join(logDir, `hurl-${logSeq + 1}`);
      return execute("hurl", hurl, [
        "--test",
        "--no-color",
        "--variable",
        `base_url=http://127.0.0.1:${devPort}`,
        "--report-json",
        reportDir,
        ...hurlFiles(input.files),
      ]);
    }
    const spec = commands[command];
    if (!spec || spec.longRunning)
      return {
        status: "rejected",
        reason: `unknown command "${command}"; allowed: ${[...Object.keys(commands), "hurl"].join(", ")}`,
      };
    return execute(command, spec.executable, spec.args, spec.timeoutMs);
  }
  if (name === "git") {
    const args = GIT_OPS[String(input.op ?? "")];
    if (!args)
      return { status: "rejected", reason: `op must be one of ${Object.keys(GIT_OPS).join(", ")}` };
    return execute(`git ${input.op}`, "git", args, 30_000);
  }
  if (name === "skill_list") return { skills: listSkills() };
  if (name === "skill_get") return getSkill(input);
  if (name === "get_log") {
    const logId = String(input.logId ?? "");
    if (!/^log-\d+$/.test(logId)) return { status: "rejected", reason: "invalid logId" };
    const lines = readFileSync(join(logDir, `${logId}.log`), "utf8").split(/\r?\n/);
    const offset = Number(input.offset ?? 0);
    const limit = Math.min(Number(input.limit ?? 200), 500);
    return {
      logId,
      offset,
      totalLines: lines.length,
      lines: lines.slice(offset, offset + limit).join("\n"),
    };
  }
  return { status: "rejected", reason: `unknown tool ${name}` };
}

const TOOLS = [
  {
    name: "skill_list",
    description:
      "List the skills JiraSync Hub provides for this run. These are the only skills available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_get",
    description:
      "Load a skill from JiraSync Hub: its SKILL.md by default, or a file it links to (e.g. references/hurl.md).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        file: { type: "string", description: "Path inside the skill, default SKILL.md" },
      },
      required: ["name"],
    },
  },
  {
    name: "run",
    description:
      "Ask the app to execute a named project command (build, test, lint, dev, hurl) in the worktree. The owner sees it live. Returns status, exitCode, durationMs, logId and the output tail.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: [...Object.keys(commands), "hurl"] },
        files: {
          type: "array",
          items: { type: "string" },
          description: "For hurl: .hurl files relative to the worktree",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "git",
    description: "Read-only git information for the worktree.",
    inputSchema: {
      type: "object",
      properties: { op: { type: "string", enum: Object.keys(GIT_OPS) } },
      required: ["op"],
    },
  },
  {
    name: "approve",
    description: "Permission handler used by the app. Not for the agent.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "get_log",
    description: "Read a page of the full output of an earlier run by logId.",
    inputSchema: {
      type: "object",
      properties: {
        logId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["logId"],
    },
  },
];

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");

async function handle(message: {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}) {
  if (message.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "harness", version: "0.1.0" },
      });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const params = message.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await callTool(params.name, params.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: String(error) }], isError: true });
      }
    }
    case "ping":
      return reply({});
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

record({ event: "mcp_start", pid: process.pid });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  devProcess?.kill();
  record({ event: "mcp_stop" });
  process.exit(0);
});
