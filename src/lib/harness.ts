// Typed client for the native harness core (src-tauri/src/harness). Only typed commands with
// validated inputs cross the bridge; the WebView never sends a command line to execute.
import { invoke } from "@tauri-apps/api/core";

export const COMMAND_NAMES = ["install", "build", "test", "lint", "dev"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CommandSpec {
  executable: string;
  args: string[];
}

export type RepoCommands = Partial<Record<CommandName, CommandSpec | null>>;

export interface ToolCheck {
  name: string;
  required: boolean;
  purpose: string;
  path: string | null;
  version: string | null;
  ok: boolean;
  detail: string | null;
}

export interface DockerCheck {
  context: string | null;
  endpoint: string | null;
  serverVersion: string | null;
  ok: boolean;
  detail: string | null;
}

export interface DoctorReport {
  tools: ToolCheck[];
  docker: DockerCheck;
  ready: boolean;
  checkedAt: number;
}

export interface RepoDetection {
  root: string;
  remoteUrl: string | null;
  defaultBranch: string;
  ecosystem: string | null;
  commands: RepoCommands;
  envFiles: string[];
  envExampleFile: string | null;
  missingEnvKeys: string[];
  serviceEnvKeys: string[];
  composeFiles: string[];
  notes: string[];
  missingExecutables: string[];
}

export interface RepoBinding {
  projectId: string;
  repoPath: string;
  baseBranch: string;
  worktreeRoot: string;
  commands: RepoCommands;
  copyEnv: string[];
  updatedAt: number;
}

export const harnessDoctor = () => invoke<DoctorReport>("harness_doctor");
export const detectRepo = (path: string) => invoke<RepoDetection>("harness_detect_repo", { path });
export const defaultWorktreeRoot = (repoPath: string) =>
  invoke<string>("harness_default_worktree_root", { repoPath });
export const listRepoBindings = () => invoke<RepoBinding[]>("harness_list_bindings");
export const saveRepoBinding = (binding: RepoBinding) =>
  invoke<RepoBinding>("harness_save_binding", { binding });
export const deleteRepoBinding = (projectId: string) =>
  invoke<void>("harness_delete_binding", { projectId });

/** `bun run test`, quoting arguments that contain spaces. */
export function formatCommand(command: CommandSpec | null | undefined): string {
  if (!command) return "";
  return [command.executable, ...command.args]
    .map((part) => (/\s/.test(part) || part === "" ? `"${part}"` : part))
    .join(" ");
}

/** Splits `bun run "my script"` into an executable + args. Empty text means "no command". */
export function parseCommand(text: string): CommandSpec | null {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of text.trim()) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(char) && !quoted) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) throw new Error(`Unclosed quote in "${text}"`);
  if (started) parts.push(current);
  const [executable, ...args] = parts;
  return executable ? { executable, args } : null;
}
