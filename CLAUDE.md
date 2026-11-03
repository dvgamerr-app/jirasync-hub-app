Same as @AGENTS.md

## Reliability + e2e log — 2026-10-08

- Added Playwright e2e (`e2e/`, `bun run test:e2e`) driving the real UI against a fake Jira; every fix below has positive + negative tests and was verified by mutation (reverting the fix turns its tests red).
- Push now sends only edited fields (`Task.dirtyFields`), pushes `Type`, surfaces failed transitions, pushes worklogs independently, and keeps edits made during a push; pull/push/discard share `runExclusiveSync`.
- Worklogs have `isOwn`/`authorName` (teammates' time no longer counted/exported/deletable); failed worklog fetches and stale-project cleanup no longer destroy local data; per-account sync errors with a readable 401.
- UI: confirm account removal, Instance URL validation, Mandays bare number = days with previews, per-task Discard, "Not pushed" badge, assignee tag, safe description links, description search on text, epic progress by status category, CSV BOM + unpushed warning, min window 1000x600.
- Open items (need a product decision / real-Tauri testing) are listed under _Remaining_ in `docs/technical-debt.md`.

Validation: `bun test --isolate` (185 pass), `bun run lint`, `bun x tsc --noEmit`, `bun run test:e2e`, `cargo check`.

## Optimization log — 2026-08-02

- Replaced full-table IndexedDB reads in `loadScopedCollections` with account-scoped Dexie index queries.
- Centralized task filtering in `filterTasks`; `Index` memoizes once and passes the result to `TaskTable`.
- Reconciled a successful single-task Jira push locally instead of reloading every collection.
- Added `AppErrorBoundary` so an uncaught React render error shows a recoverable screen.
- Removed redundant sidebar/empty-state wrappers and changed structural containers to semantic `main`/`section` elements.
- Removed unused `@tanstack/react-query`, aligned TypeScript 6 with `typescript-eslint`, and updated `postcss`, `react-router-dom`, and `jsdom`.
- Updated store and table tests for indexed loading, local sync reconciliation, and the single filtered-task data path.

Validation: `bun test`, `bun run lint`, `bun run build`, and `bun run cg:check` pass. ESLint still reports the pre-existing `react-refresh/only-export-components` warning in `TypeIcon.tsx`. `bun audit` improved from 14 to 8 advisories; the remaining advisories are currently transitive or lack compatible patched releases in the current dependency graph.

## Agent harness log — 2026-11-03

- Branch `feat/agent-harness`: run Claude or Codex on a Jira task from the AI Board — worktree from the latest `origin/<base>`, app-run install/services/migrations, read-only plan → owner approval → implement with no shell (everything executes through the in-app MCP `run` tool), app-run checks with repair rounds, independent reviewer agent, Accept → Draft PR (Ready only after CI passes).
- Phase 5: Setup → External agents grants time-limited MCP board access (ready tasks without notes; requests wait for owner approval). Phase 6: Setup → Sync exports/imports AI progress and syncs it through a git folder (no credentials, matched by Jira site + email + issue key).
- Plan and per-phase status: `docs/agent-execution-harness-plan.md`; open items: `docs/technical-debt.md` (macOS + installed build not verified yet).

Validation: `cargo test --lib` in `src-tauri` (74; also on Linux in Docker), `bun test --isolate` (221), `bun run lint`, `bun x tsc --noEmit` (+ e2e), `bun run test:e2e` (127). Opt-in real-tool tests: `cargo test --lib -- --ignored` (needs Claude, Codex, Docker).
