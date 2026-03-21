# JiraSync Hub — Agent Knowledge Base

> สรุปสภาพโปรเจกต์ที่ verify จาก source ปัจจุบัน
> อัปเดตล่าสุด: 2026-03-21

---

## Current Stack

- **Desktop shell:** Tauri 2 (`src-tauri/`)
- **Frontend:** React 19 + Vite 7 + Tailwind CSS + shadcn/ui
- **State / storage:** Zustand + Dexie IndexedDB + localStorage
- **Tooling:** Vitest, ESLint, Prettier

---

## Project Structure

```text
wedo-jirasync-hub-app/
├── index.html
├── package.json
├── vite.config.ts
├── vitest.config.ts
├── tailwind.config.ts
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── components/
│   │   ├── TitleBar.tsx
│   │   ├── JiraSettings.tsx
│   │   └── ui/
│   ├── hooks/
│   ├── lib/
│   │   ├── desktop.ts
│   │   ├── jira-api.ts
│   │   ├── jira-db.ts
│   │   ├── sync-service.ts
│   │   └── utils.ts
│   ├── pages/
│   ├── store/task-store.ts
│   ├── test/
│   └── types/jira.ts
└── src-tauri/
    ├── tauri.conf.json
    ├── Cargo.toml
    ├── capabilities/default.json
    └── src/
        ├── main.rs
        └── lib.rs
```

---

## Window Strategy

### Windows / Linux

- The app uses a **custom HTML titlebar**
- Native window decorations are disabled in Rust with `.decorations(false)`
- Frontend window actions call Tauri window APIs from `src/lib/desktop.ts`
- Resize handles in `src/App.tsx` call `startResizeDragging()`

### macOS

- The app uses the **native macOS titlebar**
- The main window is created in `src-tauri/src/lib.rs`
- macOS builder path uses:
  - `.hidden_title(true)`
  - `.title_bar_style(TitleBarStyle::Transparent)`
- Window background color is set from Rust via `cocoa`

### Capability permissions

`src-tauri/capabilities/default.json` grants:

- `core:window:allow-close`
- `core:window:allow-minimize`
- `core:window:allow-toggle-maximize`
- `core:window:allow-start-dragging`
- `core:window:allow-start-resize-dragging`
- `opener:default`

---

## Vite + Tauri Configuration

### Vite

```typescript
// vite.config.ts
plugins: [react()]
resolve.alias["@"] = path.resolve(__dirname, "src")
server.port = 1420
server.strictPort = true
server.watch.ignored = ["**/src-tauri/**"]
```

- Root HTML entry is `index.html`
- Frontend entry is `/src/main.tsx`
- `TAURI_DEV_HOST` only adjusts HMR websocket settings for `tauri dev`

### Tauri

```json
// src-tauri/tauri.conf.json
{
  "build": {
    "beforeDevCommand": "bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "bun run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": []
  }
}
```

- `main` window is created manually in Rust during `setup`
- Default window size is `1280x800`
- Minimum size is `1200x800`

---

## Jira Integration

### Authentication

```typescript
const authHeader = "Basic " + btoa(`${email}:${apiToken}`);
```

Headers sent by `jira-api.ts`:

```typescript
{
  Authorization: "Basic ...",
  "Content-Type": "application/json",
  Accept: "application/json"
}
```

### Current Jira endpoints in use

- `GET /rest/api/3/myself`
- `GET /rest/api/3/serverInfo`
- `GET /rest/api/3/project/search`
- `POST /rest/api/3/search/jql`
- `GET /rest/api/3/issue/{key}/transitions`
- `POST /rest/api/3/issue/{key}/transitions`
- `PUT /rest/api/3/issue/{key}`
- `POST /rest/api/3/issue/{key}/worklog`
- `DELETE /rest/api/3/issue/{key}/worklog/{id}`

### Request path

- Jira calls are made from the frontend with `fetch(..., { credentials: "omit" })`
- There is currently **no** Rust-side HTTP proxy

---

## Local Storage and IndexedDB

### Jira accounts

- localStorage key: `jira-accounts`
- legacy key: `jira-settings`
- `getJiraAccounts()` migrates old single-account data automatically

```typescript
interface JiraAccount {
  id: string;
  name: string;
  instanceUrl: string;
  email: string;
  apiToken: string;
}
```

### Dexie schema

Database name: `jira-task-manager`

```typescript
organizations: "id, name"
projects: "id, orgId, jiraProjectKey"
tasks: "id, projectId, jiraTaskId, status, isDirty"
workLogs: "id, taskId, logDate"
syncMeta: "id"
```

### ID namespacing

- Organization: `org-${account.id}`
- Project: `proj-${account.id}-${projectKey}`
- Task: `task-${account.id}-${issueKey}`

---

## Store and Sync Behavior

`src/store/task-store.ts`:

- loads IndexedDB rows and filters by active Jira account IDs
- marks local edits with `isDirty = true`
- pushes dirty task fields back to Jira
- syncs status, story points, severity-to-priority, mandays, note, and worklogs

`src/lib/sync-service.ts`:

- syncs all configured accounts
- preserves local dirty fields when merging remote Jira data
- replaces Jira-sourced worklogs with the latest remote copy
- updates `syncMeta["last-sync"]`
- runs background sync every 1 hour

---

## Commands

### package.json scripts

```bash
bun run dev
bun run build
bun run preview
bun run tauri
bun run format
bun run format:fix
```

### Useful direct commands

```bash
bun x vitest run
bun x eslint .
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Known Gotchas

1. macOS titlebar behavior is implemented in Rust, so frontend-only changes do not fully describe window chrome on macOS.
2. `removeJiraAccount()` removes the account plus org/project rows, but leaves namespaced task/worklog rows in Dexie.
3. `sync-service.ts` skips projects with zero matching tasks, so empty Jira projects are not persisted locally.
4. Worklog add/remove updates local IndexedDB first, then reconciles Jira asynchronously.
5. `ThemeToggle` manages theme by toggling `document.documentElement.classList`; there is no global Tauri theme bridge yet.
