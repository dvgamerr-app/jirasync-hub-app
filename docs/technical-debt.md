# Technical Debt — jirasync-hub-app

Last audited: 2026-08-02

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

**Fast Refresh warning in `TypeIcon.tsx`**

`bun run lint` passes but reports `react-refresh/only-export-components` because `TypeIcon.tsx` exports both a component and a helper. Move the helper to a non-component module when this file is next refactored.
