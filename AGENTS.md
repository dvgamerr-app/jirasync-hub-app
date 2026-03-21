# JiraSync Hub — Agent Knowledge Base

> สรุปความรู้ทางเทคนิค สถาปัตยกรรม และ patterns ที่ verified แล้ว
> อัปเดตล่าสุด: 2026-03-19

---

## Project Structure

```
jirasync-hub/
├── src/
│   ├── index.html              ← Vite entry point (root = "src/")
│   ├── bun/
│   │   └── index.ts            ← Electrobun main process (Bun runtime)
│   └── mainview/               ← React app
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── TitleBar.tsx    ← Custom draggable titlebar
│       │   └── ui/             ← shadcn/ui components
│       ├── lib/
│       │   ├── window-rpc.ts   ← Direct WebSocket RPC client (no Vite import)
│       │   ├── jira-api.ts     ← Jira REST API calls (proxied through Bun)
│       │   ├── jira-db.ts      ← localStorage multi-account + Dexie IndexedDB
│       │   ├── sync-service.ts ← Background sync orchestration
│       │   └── utils.ts
│       ├── store/task-store.ts ← Zustand state
│       ├── pages/Index.tsx
│       └── types/jira.ts
├── package.json
├── vite.config.ts
├── tailwind.config.js          ← Full shadcn theme (root)
├── tsconfig.json               ← include src/bun, exclude src/mainview
└── electrobun.config.ts
```

---

## Vite Configuration (Critical)

```typescript
// vite.config.ts
root: "src"          // NOT "src/mainview" — entry is src/index.html
outDir: "../dist"    // relative to root
alias: { "@": path.resolve(__dirname, "src/mainview") }
plugin: @vitejs/plugin-react-swc
```

```html
<!-- src/index.html — Vite entry -->
<script type="module" src="/mainview/main.tsx"></script>
```

**NEVER** set `root: "src/mainview"` — that path no longer has an index.html pointing to the right entry.

---

## Electrobun Architecture

### Runtime separation
- **Bun process** (`src/bun/index.ts`) — Node-like, has filesystem, crypto, network, full OS access
- **WebView** (`src/mainview/`) — Browser sandbox, WebView2 on Windows

### Package imports
| Context | Import |
|---------|--------|
| Bun process | `from "electrobun/bun"` |
| WebView (browser) | `from "electrobun/view"` ← only types; runtime impl is bundled separately |

### Critical: DO NOT `import("electrobun/view")` dynamically at runtime
Vite cannot resolve `../shared/rpc.js → rpc.ts` inside node_modules at build time.
The dynamic import will **fail silently** — `_rpc` stays `null`, all window controls break.

**Solution:** Use `window-rpc.ts` which is a direct WebSocket client using Electrobun's wire protocol.

---

## RPC Wire Protocol

Electrobun uses **AES-256-GCM encrypted JSON over WebSocket**.

### Connection
```
ws://localhost:${window.__electrobunRpcSocketPort}/socket?webviewId=${window.__electrobunWebviewId}
```

### Message format (request from webview → bun)
```json
{ "type": "request", "id": 42, "method": "methodName", "params": { ... } }
```
Encrypted before sending via `window.__electrobun_encrypt(json)`.

### Message format (response from bun → webview)
```json
{ "type": "response", "id": 42, "success": true, "payload": { ... } }
```
Decrypted via `window.__electrobun_decrypt(encryptedData, iv, tag)`.

### Fallback path (when WS not yet open)
`window.__electrobunBunBridge?.postMessage(rawJsonString)`

### Receiving responses from Bun (fallback via evaluateJS)
`window.__electrobun.receiveMessageFromBun(msgObject)` — override this to intercept.

---

## Window RPC Methods (bun/index.ts)

All handled in `defineElectrobunRPC<AppRPCSchema, "bun">`:

| Method | Params | Response | Notes |
|--------|--------|----------|-------|
| `windowMinimize` | — | void | |
| `windowMaximize` | — | void | also handles unmaximize |
| `windowClose` | — | void | |
| `windowSetFrame` | `{x,y,width,height}` | void | enforces MIN 1200×800 |
| `windowGetFrame` | — | `{x,y,width,height}` | reads current native frame |
| `jiraFetch` | `{url,method,headers,body?}` | `{status,body}` | proxies HTTP from Bun — no cookies |

### BrowserWindow events (bun side)
```typescript
mainWindow.on("resize", (event: any) => { const { x,y,width,height } = event.data; });
mainWindow.on("move",   (event: any) => { const { x, y } = event.data; });
```

### BrowserWindow useful methods
```typescript
mainWindow.getFrame()           // { x, y, width, height }
mainWindow.setFrame(x,y,w,h)
mainWindow.setSize(w, h)
mainWindow.setPosition(x, y)
mainWindow.minimize() / maximize() / unmaximize() / close()
mainWindow.isMaximized() / isMinimized()
```

---

## Window State Persistence

Saved to `%APPDATA%\JiraSyncHub\window-state.json` (Windows).
- Load on startup with `Bun.file(stateFile).toString()` (sync-like async)
- Save with 500ms debounce on resize/move events
- Min size: 1200×800 enforced on resize callback

---

## titleBarStyle: "hidden" on Windows

Setting `titleBarStyle: "hidden"` removes the **native resize frame** on Windows/WebView2.
Native drag regions (`WebkitAppRegion: drag`) no longer provide resize.

**Fix:** JS resize handles in `App.tsx` using `onMouseDown` + `mousemove` + `requestAnimationFrame` throttling → calls `setWindowFrame` via RPC.

```tsx
// Right edge / Bottom / Bottom-right corner
style={{ cursor: "e-resize" /* or s-resize, se-resize */ }}
```

---

## Jira API — Current Endpoints (March 2026)

### DEPRECATED / REMOVED (DO NOT USE)
| Endpoint | Status | Replacement |
|----------|--------|-------------|
| `GET /rest/api/3/search?jql=...` | **410 REMOVED** | `POST /rest/api/3/search/jql` |
| `POST /rest/api/3/search` | **410 REMOVED** | `POST /rest/api/3/search/jql` |
| `GET /rest/api/3/project` | **DEPRECATED** | `GET /rest/api/3/project/search` |

### Current endpoints used
```
GET  /rest/api/3/myself                    — test connection / current user
GET  /rest/api/3/serverInfo                — instance info
GET  /rest/api/3/project/search            — paginated projects { values[], isLast, startAt }
POST /rest/api/3/search/jql                — cursor-based issue search { issues[], isLast, nextPageToken }
GET  /rest/api/3/issue/{key}/transitions   — available status transitions
POST /rest/api/3/issue/{key}/transitions   — do a transition
PUT  /rest/api/3/issue/{key}               — update fields
POST /rest/api/3/issue/{key}/worklog       — add worklog entry
```

### search/jql request body
```json
{
  "jql": "project = HSP ORDER BY updated DESC",
  "maxResults": 100,
  "fields": ["summary", "status", "issuetype", "priority", "assignee", "description", "created", "updated", "customfield_10016", "parent"],
  "nextPageToken": "<cursor from previous response>"
}
```

### search/jql pagination
Response: `{ issues[], isLast: boolean, nextPageToken?: string }`
- Loop until `isLast === true` OR `nextPageToken` is absent

### project/search pagination
Response: `{ values[], isLast: boolean, startAt, maxResults, total }`
- Loop with `startAt += maxResults` until `isLast === true`

---

## Jira XSRF 403 — Root Cause & Fix

**Root cause:** WebView2 on Windows shares Edge's cookie store. If user is logged into Jira in Edge, session cookies are sent automatically. Jira detects cookie-based session + POST = enforces CSRF regardless of `Authorization: Basic`.

**`credentials: "omit"` is NOT sufficient** in WebView2 — Edge may still inject cookies.

**Only reliable fix:** Route all Jira API calls through the Bun process via RPC.
```typescript
// Bun has no cookie store — clean HTTP requests, no XSRF
const result = await bunJiraFetch(url, method, headers, body);
```

---

## Jira Authentication

```typescript
const authHeader = "Basic " + btoa(`${email}:${apiToken}`);
// Headers required:
{
  "Authorization": "Basic ...",
  "Content-Type": "application/json",
  "Accept": "application/json"
}
```

No `X-Atlassian-Token: no-check` needed when calls go through Bun (not browser).

---

## Multi-Account Jira Storage

Key: `"jira-accounts"` in `localStorage` → `JiraAccount[]`

```typescript
interface JiraAccount {
  id: string;
  name: string;
  instanceUrl: string;
  email: string;
  apiToken: string;
}
```

- Migration from legacy key `"jira-settings"` (single account) is handled automatically in `getJiraAccounts()`
- `getJiraSettings()` / `saveJiraSettings()` remain as backward-compat shims

---

## Dexie (IndexedDB) Schema

```typescript
db.organizations  // { id, name, jiraInstanceUrl, lastSyncedAt }
db.projects       // { id, orgId, name, jiraProjectKey, availableStatuses[] }
db.tasks          // { id, projectId, jiraTaskId, title, ... isDirty, isSynced }
db.workLogs
db.syncMeta       // { id: "last-sync", lastSyncedAt, nextSyncAt }
```

ID namespacing (per account to avoid collisions):
- Project: `proj-${account.id}-${projectKey}`
- Task: `task-${account.id}-${issueKey}`
- Org: `org-${account.id}`

---

## Atlassian Document Format (ADF)

Jira description fields return ADF objects (not plain strings) in API v3.

```typescript
function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    const sep = node.type === "paragraph" || node.type === "heading" ? "\n" : "";
    return node.content.map(adfToText).join("") + sep;
  }
  return "";
}
```

---

## React Router: HashRouter Required

Electrobun loads the webview via `views://mainview/index.html` (custom scheme / file-like).
`BrowserRouter` parses `/index.html` as a non-root path → NotFound page on startup.

**Always use `HashRouter`** for Electrobun webviews.

---

## Build Commands

```bash
bun run dev           # vite build && electrobun dev --watch
bun run dev:hmr       # concurrently vite --port 5173 && electrobun dev --watch (for HMR)
bun run hmr           # vite --port 5173
bun x vite build      # production build only
bun run test          # vitest run --config src/mainview/vitest.config.ts
bun run lint          # eslint src/mainview
```

### HMR Setup
Electrobun checks if `http://localhost:5173` is accessible on startup.
If yes → loads Vite dev server (live reload). If no → loads `views://mainview/index.html`.

---

## electrobun.config.ts — Copy Rules

```typescript
copy: {
  "dist/index.html": "views/mainview/index.html",
  "dist/assets":     "views/mainview/assets",
},
watchIgnore: ["dist/**"]
```

`dist/` must exist before `electrobun dev --watch` starts.
That's why `"dev"` script is `vite build && electrobun dev --watch`.

---

## tailwind.config.js (Root)

- `darkMode: "class"` — toggled via `.dark` on `<html>`
- `content: ["./src/mainview/**/*.{html,js,ts,jsx,tsx}"]`
- Full shadcn CSS vars: `background`, `foreground`, `border`, `sidebar-*`, etc.
- Uses `tailwindcss-animate` plugin

**There are TWO tailwind configs:**
- `tailwind.config.js` (root) — used by Vite build
- `src/mainview/tailwind.config.ts` — used by local tooling (shadcn CLI, etc.)

---

## TypeScript Config Split

- `tsconfig.json` (root) — `include: ["src/bun"]`, `exclude: ["src/mainview"]`
- `src/mainview/tsconfig.json` + `tsconfig.app.json` — for the React app

---

## Known Gotchas

1. **`dist/` must exist before `electrobun dev --watch`** — run `vite build` first
2. **`import("electrobun/view")` at runtime = silent failure** — use direct WS client instead
3. **`titleBarStyle: "hidden"` removes OS resize frame on Windows** — need custom JS handles
4. **`GET /rest/api/3/search` returns 410** — use `POST /rest/api/3/search/jql` with `nextPageToken`
5. **WebView2 cookies leak through `fetch()` even with `credentials: "omit"`** — always proxy Jira calls through Bun
6. **`BrowserRouter` breaks with `views://` scheme** — use `HashRouter`
7. **`getJiraBaseUrl()`** normalises subdomain vs full URL patterns (e.g. `mycompany.atlassian.net` → `https://mycompany.atlassian.net`)
8. **`isDirty` tasks during sync** — preserve local edits; merge incoming Jira data without overwriting dirty fields
