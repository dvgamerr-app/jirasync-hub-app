# Technical Debt — jirasync-hub-app

Last audited: 2026-07-09

## Fixed ✅

| Issue | Fix |
|---|---|
| `TASK_TYPES`, `SEVERITIES` duplicated in 2 files | Moved to `src/constants/task.ts` |
| `NO_PENDING_MANDAY = Symbol(...)` duplicated (different values!) | Moved to `src/constants/task.ts` — single shared Symbol |
| `"customfield_10016"` hardcoded in 2 files | Exported `DEFAULT_STORY_POINT_FIELD_ID` from `jira-api.ts` |
| Import after function definition in `task-store.ts` | Moved import to top |
| `NoteField` wrapper component with no logic | Removed — call `NoteFieldEditor` directly |
| `InlineNote` wrapper component with no logic | Removed — call `InlineNoteEditor` directly |
| `TaskDetailPanel` subscribed to stable `getTaskById` ref — stale data | Now derives `task`/`project`/`workLogs` inside `useShallow` selector, subscribing to live `tasks`/`projects`/`workLogs` arrays |
| `QueryClientProvider` + `@tanstack/react-query` unused | Removed `QueryClientProvider` from `App.tsx` |
| `@tanstack/react-query` still installed after `QueryClientProvider` removal | Removed the unused package from `package.json` and `bun.lock` |
| Vitest mock factories in `JiraSettings`/store tests broke on `vi.mock` hoisting | Switched the affected test handles to hoist-safe `var` bindings and completed missing mock exports |
| `TypeIcon.tsx` exported both a component and JSX helper | Moved `inferTypeIcon` into `type-icon-glyph.tsx` so Fast Refresh lint stays clean |
| `getFilteredTasks()` ran twice per render | `Index.tsx` now computes `filteredTasks` once and passes them into `TaskTable` |
| `syncTaskToJira` reloaded the whole store after a single task sync | The store now patches only the synced task and affected worklogs in memory |
| `loadScopedCollections` scanned all Dexie tables into memory | The store now loads organizations/projects/tasks/worklogs via account-scoped indexed queries |
| No React Error Boundary protected the main task workspace | Added `WorkspaceErrorBoundary` around the main content area with retry and reload actions |

## Remaining

### Medium Priority

**Unused shadcn/ui components**

Installed with shadcn/ui init but not used in the app:
- `src/components/ui/`: `carousel`, `chart`, `calendar`, `drawer`, `input-otp`, `resizable`, `menubar`, `navigation-menu`, `hover-card`, `breadcrumb`, `context-menu`
- `package.json` packages: `embla-carousel-react`, `recharts`, `react-day-picker`, `vaul`

These add bundle weight. Safe to delete UI files and run `bun remove <pkg>` for packages.

**No Dexie schema migration strategy**

`jira-db.ts` only has `this.version(1)`. Any column addition or index change requires a new version + migration function or existing user data will fail to open. Plan migrations before adding fields to the schema.

**`syncNow` → UI update is indirect**

`sync-service.ts` finishes writing to IndexedDB, then fires `notify("success")`, which triggers `reloadFromDB()` in `Index.tsx`. Brief window where DB is updated but UI is stale. Consider emitting the data directly or making `syncNow` return the new data.

### Low Priority

**`eslint-disable` for React 19 + TanStack Virtual incompatibility** (`TaskTable.tsx`)

`// eslint-disable-next-line react-hooks/incompatible-library` around `useVirtualizer`. Known upstream issue — no fix available yet. Track TanStack Virtual release notes.
