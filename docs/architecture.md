# Architecture — jirasync-hub-app

## Stack

| Layer          | Tech                               |
| -------------- | ---------------------------------- |
| Desktop shell  | Tauri v2 (Rust)                    |
| Frontend       | React 19, TypeScript, Vite         |
| Styling        | Tailwind CSS v4, shadcn/ui (Radix) |
| State          | Zustand v5                         |
| Local DB       | Dexie (IndexedDB)                  |
| List rendering | TanStack Virtual v3                |

## Offline-First Design

IndexedDB (via Dexie) is the **source of truth** for the UI. Jira API is only called during sync or push — never directly from components.

```
Jira API ──sync──► IndexedDB ──load──► Zustand store ──► React UI
                                              ▲
                       local edits (isDirty) ─┘
                                              │
                       push dirty tasks ──────┘──► Jira API
```

## Key Files

```
src/
  constants/task.ts        # Shared UI constants (TASK_TYPES, SEVERITIES, etc.)
  store/task-store.ts      # Single Zustand store — all UI state + async ops
  lib/
    sync-service.ts        # Background sync loop (1 hr interval), Jira pull
    jira-api.ts            # Jira REST API v3, ADF parsing
    jira-db.ts             # Dexie schema (v1), account encryption
    worklog-sync.ts        # WorkLog state machine helpers
    worklog-time.ts        # Time formatting / parsing (mandays ↔ minutes)
    jira-ids.ts            # Scoped ID generation (task-{accountId}-{key})
  types/jira.ts            # Core types: Task, Project, Organization, WorkLog
  pages/Index.tsx          # Root page — layout, toolbar, sync lifecycle
  components/
    TaskTable.tsx          # Virtualised task table with inline editing
    TaskDetailPanel.tsx    # Right-side detail panel, subscribed to live task state
    AppSidebar.tsx         # Project navigation
```

## ID Scheme

All entity IDs are account-scoped to support multiple Jira accounts without key collisions:

```
org-{accountId}
proj-{accountId}-{projectKey}
task-{accountId}-{issueKey}
```

## Sync Strategy

### Pull (Jira → Local)

1. `fetchAssignedJiraData()` — paginated JQL, linked issues, parent epics
2. `mergeRemoteTaskWithLocalState()` — preserves only the fields listed in `dirtyFields` (plus the local note) over remote values; each account is pulled in its own try/catch
3. `replaceTaskWorklogs()` — replace Jira-sourced logs, keep `pending_create`/`pending_delete`
4. `fetchProjectMetadata()` — all projects in parallel (`Promise.allSettled`)

### Push (Local → Jira)

All of push, pull and discard run inside `runExclusiveSync()` (`src/lib/sync-lock.ts`) so they never overlap.

1. `pushTaskToJira()` — PUT only the fields in `task.dirtyFields` (a legacy dirty record without it sends everything) + `transitionJiraIssue` when `status` is dirty; failures throw
2. `syncTaskWorkLogsToJira()` — create/delete pending worklogs (runs even if step 1 failed)
3. If both succeeded and the task was not edited meanwhile (`updatedAt` unchanged) mark `isDirty=false, isSynced=true, dirtyFields=[]`; otherwise keep the newer dirty record

### WorkLog State Machine

```
pending_create ──push──► synced
pending_create ──delete──► (removed from DB)
synced         ──delete──► pending_delete ──push──► (removed from DB)
```

## Account Security

Jira credentials (`JiraAccount`) are stored in `localStorage` encrypted via AES-GCM through Tauri's `invoke("encrypt_data")` / `invoke("decrypt_data")`.

## Dexie Schema (v1)

```ts
organizations: "id, name";
projects: "id, orgId, jiraProjectKey";
tasks: "id, projectId, jiraTaskId, status, isDirty";
workLogs: "id, taskId, logDate";
syncMeta: "id";
```

> **Note:** Only version 1 is defined. Any schema changes require adding a new `this.version(N)` with a migration function.
