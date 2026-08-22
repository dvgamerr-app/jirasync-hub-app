Same as @AGENTS.md

## Optimization log — 2026-08-02

- Replaced full-table IndexedDB reads in `loadScopedCollections` with account-scoped Dexie index queries.
- Centralized task filtering in `filterTasks`; `Index` memoizes once and passes the result to `TaskTable`.
- Reconciled a successful single-task Jira push locally instead of reloading every collection.
- Added `AppErrorBoundary` so an uncaught React render error shows a recoverable screen.
- Removed redundant sidebar/empty-state wrappers and changed structural containers to semantic `main`/`section` elements.
- Removed unused `@tanstack/react-query`, aligned TypeScript 6 with `typescript-eslint`, and updated `postcss`, `react-router-dom`, and `jsdom`.
- Updated store and table tests for indexed loading, local sync reconciliation, and the single filtered-task data path.

Validation: `bun test`, `bun run lint`, `bun run build`, and `bun run cg:check` pass. ESLint still reports the pre-existing `react-refresh/only-export-components` warning in `TypeIcon.tsx`. `bun audit` improved from 14 to 8 advisories; the remaining advisories are currently transitive or lack compatible patched releases in the current dependency graph.
