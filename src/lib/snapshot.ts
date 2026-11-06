// Portable snapshot of what only this app knows (Phase 6): AI Board progress and, if the owner
// chooses, local notes. Jira data is not included (a sync restores it), repo bindings stay per
// machine (they hold local paths), and no credential is ever written. Tasks are matched across
// machines by Jira instance + account email + issue key, never by issue key alone.
import { invoke } from "@tauri-apps/api/core";
import { isAiBoardStatus, type AiBoardStatus, type AiBoardTaskState } from "@/lib/ai-board";
import { getAccountIdFromTask, getTaskId, getTaskIdPrefix } from "@/lib/jira-ids";
import type { JiraAccount } from "@/lib/jira-db";
import type { Task } from "@/types/jira";

export const SNAPSHOT_FORMAT = "jirasync-snapshot";
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FILE = "jirasync-snapshot.json";

interface SnapshotAccount {
  ref: string;
  instanceUrl: string;
  email: string;
}

interface SnapshotAiState {
  account: string;
  issueKey: string;
  status: AiBoardStatus;
  jiraDone: boolean;
  updatedAt: string;
}

interface SnapshotNote {
  account: string;
  issueKey: string;
  note: string;
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  exportedAt: string;
  accounts: SnapshotAccount[];
  aiStates: SnapshotAiState[];
  notes?: SnapshotNote[];
}

export interface ImportReport {
  aiStates: number;
  notes: number;
  /** AI states that were older than this machine's copy. */
  olderIgnored: number;
  /** Issue keys whose local note differs from the incoming one (local kept). */
  noteConflicts: string[];
  /** Notes for tasks this machine has not synced yet. */
  missingTasks: string[];
  /** Jira accounts in the snapshot that are not set up here. */
  unknownAccounts: string[];
}

export interface ImportPlan {
  aiStates: AiBoardTaskState[];
  notes: { taskId: string; note: string }[];
  report: ImportReport;
}

function accountKey(instanceUrl: string, email: string): string {
  const instance = instanceUrl
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return `${instance}|${email.trim().toLowerCase()}`;
}

function issueKeyOf(taskId: string, accountId: string): string {
  return taskId.slice(getTaskIdPrefix(accountId).length);
}

export function buildSnapshot(
  accounts: JiraAccount[],
  aiStates: AiBoardTaskState[],
  tasks: Task[],
  { includeNotes }: { includeNotes: boolean },
  now = new Date(),
): Snapshot {
  // Only these fields leave the app; tokens and names are never copied.
  const refs = new Map(accounts.map((account, index) => [account.id, `a${index + 1}`]));
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: now.toISOString(),
    accounts: accounts.map((account) => ({
      ref: refs.get(account.id)!,
      instanceUrl: account.instanceUrl,
      email: account.email,
    })),
    aiStates: aiStates
      .filter((state) => refs.has(state.accountId))
      .map((state) => ({
        account: refs.get(state.accountId)!,
        issueKey: issueKeyOf(state.id, state.accountId),
        status: state.status,
        jiraDone: state.jiraDone,
        updatedAt: state.updatedAt,
      })),
  };
  if (includeNotes) {
    snapshot.notes = tasks.flatMap((task) => {
      const accountId = getAccountIdFromTask(task);
      const ref = accountId && refs.get(accountId);
      return ref && task.note?.trim()
        ? [{ account: ref, issueKey: task.jiraTaskId, note: task.note }]
        : [];
    });
  }
  return snapshot;
}

/** Throws a readable error for anything that is not a snapshot this version can read. */
export function parseSnapshot(text: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error("This file is not a JiraSync snapshot (not JSON)");
  }
  const snapshot = value as Partial<Snapshot>;
  if (snapshot?.format !== SNAPSHOT_FORMAT) throw new Error("This file is not a JiraSync snapshot");
  if (typeof snapshot.version !== "number" || snapshot.version > SNAPSHOT_VERSION)
    throw new Error(
      `This snapshot is version ${snapshot.version}; update JiraSync Hub to import it`,
    );
  if (!Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.aiStates))
    throw new Error("This snapshot is incomplete");
  for (const state of snapshot.aiStates)
    if (!isAiBoardStatus(state.status))
      throw new Error(`Unknown AI status "${String(state.status)}" in the snapshot`);
  return snapshot as Snapshot;
}

export function planImport(
  snapshot: Snapshot,
  local: { accounts: JiraAccount[]; aiStates: AiBoardTaskState[]; tasks: Task[] },
): ImportPlan {
  const localByKey = new Map(
    local.accounts.map((account) => [accountKey(account.instanceUrl, account.email), account.id]),
  );
  const accountFor = new Map<string, string>();
  const unknownAccounts: string[] = [];
  for (const account of snapshot.accounts) {
    const id = localByKey.get(accountKey(account.instanceUrl, account.email));
    if (id) accountFor.set(account.ref, id);
    else unknownAccounts.push(`${account.email} @ ${account.instanceUrl}`);
  }
  const currentStates = new Map(local.aiStates.map((state) => [state.id, state]));
  const tasks = new Map(local.tasks.map((task) => [task.id, task]));
  const report: ImportReport = {
    aiStates: 0,
    notes: 0,
    olderIgnored: 0,
    noteConflicts: [],
    missingTasks: [],
    unknownAccounts,
  };

  const aiStates: AiBoardTaskState[] = [];
  for (const incoming of snapshot.aiStates) {
    const accountId = accountFor.get(incoming.account);
    if (!accountId) continue;
    const id = getTaskId(accountId, incoming.issueKey);
    const current = currentStates.get(id);
    if (current && current.updatedAt >= incoming.updatedAt) {
      report.olderIgnored += 1;
      continue;
    }
    aiStates.push({
      id,
      accountId,
      status: incoming.status,
      // Jira completion only ever moves one way.
      jiraDone: incoming.jiraDone || !!current?.jiraDone,
      updatedAt: incoming.updatedAt,
    });
  }
  report.aiStates = aiStates.length;

  const notes: ImportPlan["notes"] = [];
  for (const incoming of snapshot.notes ?? []) {
    const accountId = accountFor.get(incoming.account);
    if (!accountId) continue;
    const task = tasks.get(getTaskId(accountId, incoming.issueKey));
    if (!task) {
      report.missingTasks.push(incoming.issueKey);
      continue;
    }
    const current = task.note?.trim() ?? "";
    if (current === incoming.note.trim()) continue;
    if (current) {
      report.noteConflicts.push(incoming.issueKey);
      continue;
    }
    notes.push({ taskId: task.id, note: incoming.note });
  }
  report.notes = notes.length;
  return { aiStates, notes, report };
}

export interface SnapshotPushResult {
  committed: boolean;
  pushed: boolean;
}

/** Fast-forwards the git sync folder and returns the snapshot it holds (null if none yet). */
export const pullSnapshotFolder = (folder: string) =>
  invoke<string | null>("harness_snapshot_pull", { folder });
/** Writes the snapshot into the git sync folder, commits only that file, pushes if possible. */
export const pushSnapshotFolder = (folder: string, content: string) =>
  invoke<SnapshotPushResult>("harness_snapshot_push", { folder, content });
