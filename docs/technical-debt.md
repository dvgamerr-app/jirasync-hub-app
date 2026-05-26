# Technical Debt — jirasync-hub-app

Last audited: 2026-05-26

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

## Remaining

### High Priority

**`loadScopedCollections` loads ALL records to memory** (`task-store.ts:174`)

All four tables are loaded with `.toArray()` then filtered in JavaScript. Should use Dexie indexed queries:
```ts
// Instead of:
const allTasks = await db.tasks.toArray();
const tasks = allTasks.filter(t => isTaskIdForAccounts(t.id, accountIds));

// Better:
const tasks = await db.tasks
  .where("id").startsWith(`task-${accountId}-`)
  .toArray();
```
Impact: Memory usage and load time for large datasets.

**`getFilteredTasks()` computed twice per render**

`Index.tsx` and `TaskTable.tsx` each call `getFilteredTasks()` independently. Both re-run the full filter + sort pipeline. Fix: compute once in `Index.tsx`, pass as prop to `TaskTable`, or memoize with `useMemo` in the store selector.

**`syncTaskToJira` reloads everything for a single task** (`task-store.ts:527`)

After syncing one task, calls `reloadFromDB()` which re-fetches all organizations/projects/tasks/worklogs. Should patch just the synced task in the Zustand state instead.

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

**No React Error Boundary**

No error boundary wraps `TaskTable` or `TaskDetailPanel`. A runtime error inside either would crash the whole app with a blank screen. Add an `<ErrorBoundary>` around the main content area in `Index.tsx`.

**`eslint-disable` for React 19 + TanStack Virtual incompatibility** (`TaskTable.tsx`)

`// eslint-disable-next-line react-hooks/incompatible-library` around `useVirtualizer`. Known upstream issue — no fix available yet. Track TanStack Virtual release notes.

**`@tanstack/react-query` still in `package.json`**

`QueryClientProvider` has been removed from `App.tsx` but the package itself is still installed. Run:
```bash
bun remove @tanstack/react-query
```
