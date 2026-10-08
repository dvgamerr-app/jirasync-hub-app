# Technical Debt — jirasync-hub-app

Last audited: 2026-10-08

## Fixed ✅

| Issue                                                                 | Fix                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TASK_TYPES`, `SEVERITIES` duplicated in 2 files                      | Moved to `src/constants/task.ts`                                                                                               |
| `NO_PENDING_MANDAY = Symbol(...)` duplicated (different values!)      | Moved to `src/constants/task.ts` — single shared Symbol                                                                        |
| `"customfield_10016"` hardcoded in 2 files                            | Exported `DEFAULT_STORY_POINT_FIELD_ID` from `jira-api.ts`                                                                     |
| Import after function definition in `task-store.ts`                   | Moved import to top                                                                                                            |
| `NoteField` wrapper component with no logic                           | Removed — call `NoteFieldEditor` directly                                                                                      |
| `InlineNote` wrapper component with no logic                          | Removed — call `InlineNoteEditor` directly                                                                                     |
| `TaskDetailPanel` subscribed to stable `getTaskById` ref — stale data | Now derives `task`/`project`/`workLogs` inside `useShallow` selector, subscribing to live `tasks`/`projects`/`workLogs` arrays |
| `QueryClientProvider` + `@tanstack/react-query` unused                | Removed `QueryClientProvider` from `App.tsx`                                                                                   |
| `loadScopedCollections` loaded all IndexedDB records                  | Replaced full-table reads with account-scoped Dexie index queries                                                              |
| `getFilteredTasks()` computed in both `Index` and `TaskTable`         | Added pure `filterTasks`; `Index` memoizes once and passes the result to `TaskTable`                                           |
| `syncTaskToJira` reloaded all collections                             | Reconciles only the synced task and its worklogs in Zustand                                                                    |
| No React Error Boundary                                               | Added `AppErrorBoundary` around the application shell                                                                          |
| `@tanstack/react-query` remained installed                            | Removed the unused dependency and lockfile entries                                                                             |
| TypeScript 7 was unsupported by `typescript-eslint`                   | Aligned TypeScript to the supported 6.x range, restoring lint execution                                                        |

### Fixed 2026-10-08 (each has Playwright positive + negative tests in `e2e/`)

| Issue                                                                                             | Fix                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Teammates' worklogs were counted as the user's own (table, Export, speed rate) and deletable      | Worklogs carry `isOwn`/`authorName`; only `isCountedWorkLog` counts; teammates' logs are read-only         |
| Every push re-sent all fields (wiped story point 8, remapped priority, rewrote description)       | `Task.dirtyFields`: push and pull-merge only touch fields the user edited; legacy dirty records stay "all" |
| Changing Type was never pushed                                                                    | `issuetype` is sent when `type` is dirty                                                                   |
| A failed status transition was swallowed and the task marked synced                               | The error is thrown (task stays dirty, toast explains); worklogs are pushed independently of field updates |
| Edits made while a push was in flight were overwritten by the pushed snapshot                     | `persistSyncedTask` keeps the newer record when `updatedAt` changed                                        |
| Pull and push could run at the same time                                                          | `runExclusiveSync()` lock (`src/lib/sync-lock.ts`) around pull, push, discard                              |
| Note was reset to `null` on every pull                                                            | A pull never overwrites the local note                                                                     |
| A failed full-worklog fetch emptied that task's worklogs                                          | `worklogFetchFailedTaskIds`: those tasks keep their local worklogs                                         |
| Removing a stale project deleted unpushed tasks/worklogs                                          | Dirty tasks and tasks with pending worklogs (and their project) are kept                                   |
| One broken account aborted the whole sync; 401 showed a raw error                                 | Per-account try/catch, `describeSyncError()` explains 401/403/429                                          |
| Unbounded per-issue worklog requests                                                              | `mapWithConcurrency` limit 4                                                                               |
| Removing a Jira account needed no confirmation                                                    | AlertDialog, warns how many tasks have unpushed changes                                                    |
| Instance URL accepted anything; `acme.atlassian.net` became `acme.atlassian.net.atlassian.net`    | `validateJiraInstanceUrl()` + `getJiraBaseUrl()` fix                                                       |
| Bare number in Mandays meant hours; no feedback on what was understood                            | `parseMandayInput` (bare number = days) + live preview in Mandays / Log Work, >24h warning                 |
| Search matched ADF JSON keywords ("paragraph")                                                    | `getDescriptionSearchText()`                                                                               |
| Epic progress ignored Jira status category ("Resolved" not counted)                               | Uses `isDoneTask()` (statusCategory)                                                                       |
| Description links used `target=_blank` and allowed `javascript:`                                  | `openExternal` + `getSafeExternalUrl()` (http/https/mailto only)                                           |
| CSV had no BOM (Thai garbled in Excel); Export skipped created-by-me tickets; no unpushed warning | BOM, export all tasks (rows only for own worklogs), unpushed-worklog warning                               |
| Tickets now assigned to others looked like mine; unpushed worklogs looked synced                  | Assignee tag + dimmed row; "Not pushed" badge                                                              |
| Per-task sync failure hid the reason; only "Discard all" existed                                  | Toast shows Jira's reason; per-task Discard                                                                |
| Min window 1200×800 did not fit small laptops; duplicate `http:default` capability                | 1000×600 (Rust, verify with `cargo check`); capability deduped                                             |

### Fixed 2026-10-09 (decisions from the debt review; no new test scripts were added for these)

| Issue                                                         | Fix                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira API tokens sat in localStorage (machine-derived AES key) | Tokens live in the OS credential store (Windows Credential Manager / macOS Keychain) via `store_secret`/`get_secret`/`delete_secret`. Legacy tokens migrate on first start; a token is only removed from the blob after it is written **and read back identically**. Linux / any failure keeps the old encrypted-blob storage |
| `csp` was `null`                                              | Real CSP in `tauri.conf.json` (+ `devCsp`); `dangerousDisableAssetCspModification: ["style-src"]` keeps `'unsafe-inline'` effective (Tauri would otherwise add a hash and disable it)                                                                                                                                         |
| No Dexie migration strategy                                   | `SCHEMA_VERSIONS` list in `jira-db.ts` (append-only, upgrade functions in one transaction), v2 migration, `ensureDatabaseReady()` shows a non-destructive error screen instead of ever deleting data                                                                                                                          |
| Pull re-read the whole assigned history every hour            | Incremental pull (`updated >= -Nm`, relative so time zones don't matter) with a per-account cursor in `syncMeta` (`account:<id>`). Full pull on first run, manual Sync, after a story-point mapping change, when data is missing, or every 24 h (only a full pull removes/archives)                                           |
| `syncNow` → UI update went through a notification + reload    | `syncNow()` returns a `SyncResult` (also `onSyncResult`) that `applySyncResult()` merges into Zustand directly — no IndexedDB re-read                                                                                                                                                                                         |
| Status dropdown offered unreachable statuses                  | `loadTransitionOptions()` (store, cached 60 s) narrows the list to Jira's transitions + the current status; unknown/offline → all project statuses as before                                                                                                                                                                  |
| Note overwrote the Jira description                           | Note is local-only (never dirty, never pushed). "Post as Jira comment" sends it explicitly. Dexie v2 clears the stale "dirty" state of tasks whose only change was the note (note text untouched)                                                                                                                             |
| 30 unused shadcn/ui files and 21 packages                     | Removed after a reference scan (only truly unreferenced files); `calendar` and `recharts` were wrongly listed before — they are used                                                                                                                                                                                          |
| Fast Refresh warning in `TypeIcon.tsx`                        | `inferTypeIcon` moved to `infer-type-icon.tsx`; `bun run lint` is warning-free                                                                                                                                                                                                                                                |

## Remaining

### Medium Priority

**Verify keychain + CSP in a real Tauri build**

Checked: `cargo check`, a Windows Credential Manager round trip, the token-migration logic, and the UI under the exact CSP in Chromium (zero violations). Not checked: a packaged app on Windows/macOS/Linux.
Known risks: (1) macOS builds are ad-hoc signed, so after an update macOS may ask for the keychain password again; (2) Linux has no keychain support yet (`keyring`'s Secret Service backend needs libdbus — add it once the Linux CI job can compile it); (3) any local process running as the same user can still read the keychain item.

**Sync lock is held for a whole pull**

`runExclusiveSync` serialises pull, push and discard. A long pull makes a push wait without feedback; accounts are pulled one after another. Consider per-account locks or showing "waiting for sync".

**Silent non-pushes**

Setting severity to `NA` or clearing mandays sends nothing to Jira but the task is marked synced, and the next pull restores Jira's value. Decide whether to disallow `NA`/empty or send an explicit clear.

**Edit-during-push detection uses a millisecond `updatedAt`**

Two edits in the same millisecond are indistinguishable. A monotonic revision counter on `Task` would be exact.

### Low Priority

**`eslint-disable` for React 19 + TanStack Virtual incompatibility** (`TaskTable.tsx`)

`// eslint-disable-next-line react-hooks/incompatible-library` around `useVirtualizer`. Known upstream issue — kept as the single targeted suppression; track TanStack Virtual release notes.
