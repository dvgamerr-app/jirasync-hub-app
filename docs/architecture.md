# Architecture — jirasync-hub-app

## Additional Board View

`src/pages/AiBoard.tsx` adds the `/ai-board` hash route alongside the original `/` page. The original task table and layout remain in place; sidebar links provide navigation between the two pages.

The board uses existing account-scoped tasks/projects and the single `task-store.ts`. Its AI workflow is independent: fixed `todo`, `doing`, `review`, `done` columns persist in `aiBoardStates` without touching Jira task fields or dirty state. Human completion in Jira sets AI work to Done; AI completion never transitions Jira. Pull sync persists that completion before emitting its result, including when a locally edited Jira status differs from the server. Reopening Jira releases the completion lock but retains AI progress until explicitly moved.

App.tsx owns initial IndexedDB loading, background sync and sync-result/status subscriptions across routes. Initial loads share an in-flight promise and reuse loaded memory; explicit settings/discard reloads still reread IndexedDB. Switching pages does not restart pull sync. Jira table rows subscribe to their own transition targets and mount dropdown contents only while open.

Board selection/search are separate store fields. Description, local notes and AI handoff dialogs share existing data. `ai-board.css` scopes the layout to this page and uses the app's background/card/primary/warning/success theme tokens in light and dark modes. No native capability changes are required.

Jira-completed tasks are hidden from board cards, counts and the detail panel without deleting task or AI state records; AI-completed tasks remain visible when Jira is still open. Space visibility uses its own `jirasync-ai-hidden-projects` localStorage preference and filters the All projects view. Hidden spaces remain available in the sidebar for direct navigation or restoring visibility; hiding a space leaves the current project and detail selection unchanged, matching the Jira view. The original Jira view's visibility preferences remain separate.

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
    jira-db.ts             # Append-only Dexie schema (v3), account encryption
    ai-board.ts            # Independent AI workflow and one-way Jira completion
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

## Dexie Schema (v3)

```ts
organizations: "id, name";
projects: "id, orgId, jiraProjectKey";
tasks: "id, projectId, jiraTaskId, status, isDirty";
workLogs: "id, taskId, logDate";
syncMeta: "id";
aiBoardStates: "id, accountId, status";
```

`SCHEMA_VERSIONS` is append-only: v1 defines the original tables, v2 migrates local-only notes, and v3 adds `aiBoardStates` without reshaping existing data. AI rows use the account-scoped task ID as their primary key and are removed on confirmed account removal. Pull/discard never reset ordinary AI progress. Older binaries cannot open the upgraded database; rollback must retain v3 and disable the UI in a forward fix, without deleting data.
