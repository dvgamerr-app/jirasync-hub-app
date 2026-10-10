# JiraSync Hub — Agent Notes

## App in 1 minute

- Desktop app สำหรับ sync Jira tasks/worklogs มาทำงานในเครื่อง, แก้แบบ offline-first-ish, แล้ว push เฉพาะ task ที่ dirty กลับ Jira
- รองรับเฉพาะ `windows`, `linux`, `macos`
- Stack หลัก: Tauri 2, React 19, Vite 7, Tailwind + shadcn/ui, Zustand, Dexie, localStorage, Vitest

## Code map

- `src/App.tsx`: app shell, titlebar/resize handles, `HashRouter`
- `src/pages/Index.tsx`: main dashboard, sync/export/settings controls
- `src/store/task-store.ts`: source of truth ของ UI, dirty state, push ไป Jira
- `src/lib/sync-service.ts`: background pull sync ทุก 1 ชั่วโมงแบบ **incremental** (`updated >= -Nm`) ส่วน Sync ที่กดเอง/รอบแรก/ครบ 24 ชม. เป็น **full** (มีแต่ full ที่ลบ/archive ได้); แยก error ต่อ account; `syncNow()` คืน `SyncResult` ให้ store `applySyncResult()` โดยตรง (ไม่ reload จาก DB)
- `src/lib/sync-lock.ts`: `runExclusiveSync()` — pull กับ push (และ discard) ต้องผ่าน lock นี้เสมอ ห้ามรันพร้อมกัน
- `e2e/`: Playwright e2e (`*.e2e.ts`) + `fake-jira.ts` (Jira จำลองผ่าน `page.route`) + `shims/` (แทน Tauri plugins เฉพาะ `vite --mode e2e`)
- `src/lib/jira-api.ts`: Jira HTTP client + Jira -> local model mapping
- `src/lib/jira-db.ts`: Dexie + localStorage helpers
- `src/lib/jira-ids.ts`: account-scoped IDs
- `src/components/JiraSettings.tsx`: Jira accounts + story point field mapping
- `src/components/ExportDialog.tsx`: export CSV ผ่าน Tauri dialog/fs
- `src-tauri/src/lib.rs`: สร้าง main window และลง plugins

## Data / storage

- localStorage:
  - `jira-accounts` (encrypted blob ของรายการ account; **API token อยู่ใน OS credential store** — Windows Credential Manager / macOS Keychain ผ่าน `store_secret`/`get_secret`/`delete_secret`; blob เก็บ `apiToken: ""`. ถ้าใช้ keychain ไม่ได้ (Linux/error) token ยังอยู่ใน blob เหมือนเดิม — ห้ามลบ token ออกจาก blob จนกว่าจะเขียนและอ่านกลับจาก keychain ได้ตรงกัน)
  - `jira-force-full-sync` = flag ให้ sync รอบถัดไปอ่านทั้งหมดใหม่ (ตั้งเมื่อเปลี่ยน story point mapping)
  - `jira-settings` เป็น legacy key และ migrate อัตโนมัติ
  - `jira-story-point-fields` = `{ [projectId]: jiraCustomFieldId }`
- IndexedDB (`jira-task-manager`):
  - `organizations: "id, name"`
  - `projects: "id, orgId, jiraProjectKey"`
  - `tasks: "id, projectId, jiraTaskId, status, isDirty"`
  - `workLogs: "id, taskId, logDate"`
  - `syncMeta: "id"` (`last-sync` + `account:<accountId>` = cursor ของ incremental sync: `lastSyncedAt`, `lastFullSyncAt`)
- schema เปลี่ยนต้องเพิ่ม entry ใหม่ใน `SCHEMA_VERSIONS` (`src/lib/jira-db.ts`) เท่านั้น ห้ามแก้/ลบ entry เดิม ห้าม `db.delete()`; ตอนนี้อยู่ที่ v2 (ล้าง dirty ที่เกิดจากการแก้ note)
- ID format:
  - org: `org-${accountId}`
  - project: `proj-${accountId}-${projectKey}`
  - task: `task-${accountId}-${issueKey}`

## Jira behavior

- Auth = Basic `email:apiToken`
- Frontend เรียก Jira ตรงผ่าน `@tauri-apps/plugin-http`; ยังไม่มี Rust proxy
- Endpoint ที่ใช้จริง:
  - `myself`, `serverInfo`, `project/search`, `project/{key}/statuses`, `field`, `search/jql`
  - `issue/{key}`, `issue/{key}/transitions`, `issue/{key}/worklog`, `issue/{key}/worklog/{id}`
- Pull sync:
  - ดึง issue ที่ current user ถูก assign หรือเคยถูก assign
  - ดึง linked issues เพิ่ม ถ้ายังไม่ติดมาจาก query หลัก
  - merge statuses จาก project endpoint + statuses ที่เห็นจาก issues
- Push sync:
  - ส่ง **เฉพาะ field ที่ user แก้จริง** (`task.dirtyFields`): story points, priority จาก severity, timetracking, issuetype จาก `type`, และ transition จาก `status` (**ไม่ส่ง `note`** — note เป็น local-only; ส่งเป็น Jira comment ได้ด้วยปุ่ม "Post as Jira comment")
  - task ที่ dirty เพราะ worklog อย่างเดียวจะไม่ยิง `PUT issue` เลย; dirty record เก่าที่ไม่มี `dirtyFields` ถือว่า dirty ทุก field (legacy)
  - field update กับ worklog เป็นอิสระต่อกัน: ถ้า field update/transition พลาด worklog ยังถูกส่ง แต่ task ยัง dirty และ throw error ที่บอกสาเหตุ
  - ถ้า user แก้ task ระหว่างที่กำลัง push (`updatedAt` เปลี่ยน) task จะยังเป็น dirty — ห้ามเขียนทับด้วย snapshot ที่ push ไป
  - `mandays` ภายในระบบคิดเป็น decimal day โดย `1 = 8 ชั่วโมง`
  - severity map เป็น `Critical -> Highest`, `High -> High`, `Medium -> Medium`, `Low -> Low`

## Current product behavior

- แก้จาก UI ได้: status, type, severity, story level, mandays, note, worklogs
- `storyLevel` รับเฉพาะ `1 | 2 | 3 | 5`
- `task.description` เก็บ Jira description เดิม; ถ้าเป็น ADF จะเก็บเป็น JSON string เพื่อ render ด้วย `AdfRenderer`
- `task.note` เป็น field local-only: แก้แล้วไม่ทำให้ task dirty, ไม่ถูก push, ไม่ถูก pull ทับ, และ Discard ไม่ลบ
- Worklog ใช้ `syncStatus = synced | pending_create | pending_delete`
- Mandays: ตัวเลขเปล่า = **วัน** (`parseMandayInput`, `2` = 2d); Log Work: ตัวเลขเปล่า = ชั่วโมง (`parseTimeInput`) — ทั้งสองช่องมี preview ว่าตีความเป็นอะไร และเตือนถ้า log เกิน 24h
- ปุ่ม Discard ต่อ task (`discardTask`) คืนค่าจาก Jira และทิ้ง worklog ที่ยังไม่ push; มี "Discard all" ด้านบนเหมือนเดิม
- ลิงก์ใน description เปิดผ่าน `openExternal` เท่านั้น และรับแค่ `http(s):`/`mailto:` (`getSafeExternalUrl`)
- Search ค้น text ของ description (`getDescriptionSearchText`) ไม่ใช่ JSON ของ ADF
- Export CSV ใช้เฉพาะ worklogs ของเรา (`isCountedWorkLog`) ที่ยัง visible และเลือก export ตามเดือน; ไฟล์ที่ save มี UTF-8 BOM; รวม ticket ที่เราสร้างแต่ assign ให้คนอื่นถ้าเรา log เวลาไว้; เตือนถ้ามี worklog ที่ยังไม่ push
- Story point field ต่อ project เลือกได้ใน Jira Settings และ auto-detect จาก numeric custom fields ที่มีค่าจริง

## Window / platform

- รองรับเฉพาะ desktop; อย่าอ้างรองรับ `android` หรือ `ios`
- Windows/Linux: custom HTML titlebar + resize handles
- macOS: native transparent titlebar จาก Rust (`hidden_title`, `TitleBarStyle::Transparent`)
- main window ถูกสร้างใน Rust (`src-tauri/src/lib.rs`) ไม่ได้ประกาศใน `tauri.conf.json`
- Window state restore ผ่าน `tauri-plugin-window-state`
- Tauri plugins ที่ใช้จริง: `http`, `dialog`, `fs`, `opener`, `window-state`
- capability HTTP อนุญาต `https://*.atlassian.net`

## Rules / gotchas

**Offline-first.** IndexedDB is source of truth. Never call Jira API from components — only through `task-store.ts` or `sync-service.ts`.

**Single store.** All UI state + async ops go through `src/store/task-store.ts` (Zustand). Don't create parallel state.

**Persist before push.** All task mutations: `updateTask()` → `markDirtyAndPersist()` → IndexedDB write in background. Then sync to Jira separately.

**Shared constants.** `TASK_TYPES`, `SEVERITIES`, `STORY_LEVEL_OPTIONS`, `NO_PENDING_MANDAY` live in `src/constants/task.ts`. `DEFAULT_STORY_POINT_FIELD_ID` exported from `src/lib/jira-api.ts`.

**useShallow selectors must return stable references.** Never create new array/object instances inside a `useShallow` selector (e.g. `.filter()`, `.sort()`, `?? []`). `useShallow` uses reference equality — new instances every call = infinite render loop. Pattern: subscribe to raw arrays in `useShallow`, then derive computed values with `useMemo` in the component body. Getter functions (`getTaskById`, etc.) are stable refs and won't trigger re-renders when data changes — subscribe to `tasks`/`projects`/`workLogs` directly instead.

**No wrapper components.** Don't create one-liner wrapper components. Call the underlying component directly.

- `createExportRows()` ใน `ExportDialog.tsx` ต้อง group worklogs ที่ task เดียวกัน + เดือนเดียวกันเข้าด้วยกัน (key = `taskId::periodValue`) และ sum `timeSpentMinutes` ก่อน build rows — ห้ามสร้าง 1 row ต่อ 1 worklog ตรงๆ เพราะจะทำให้ ticket id ซ้ำใน CSV และ clipboard
- อย่า hardcode story point field ใหม่ตรงๆ; ใช้ `getStoryPointFieldMap()[projectId] ?? "customfield_10016"`
- `JiraIssueFields` ต้องมี `[key: string]: unknown` เพื่อรองรับ dynamic custom fields
- `detectStoryPointCandidates()` ต้อง fail เงียบและ return `[]`
- mock `@/lib/jira-db` ใน Vitest ต้อง export `getStoryPointFieldMap`
- `removeJiraAccount()` ปัจจุบันลบ org/project/task/worklog ของ account นั้นออกจาก local DB แล้ว
- `sync-service.ts` ยัง persist เฉพาะ project ที่มี fetched issues; project ว่างจะไม่ถูกเก็บ
- `removeStaleProjectsForAccount()` ลบ project ที่ Jira ไม่คืนมาแล้วพร้อม tasks/worklogs ของมัน **ยกเว้น** task ที่ dirty หรือมี worklog ค้าง push (task + project ของมันจะถูกเก็บไว้)
- worklog ที่ดึงมาจาก Jira มี `isOwn`/`authorName`; ยอดเวลา, Export, Speed rate นับเฉพาะของเรา (`isCountedWorkLog`) และลบ worklog ของคนอื่นไม่ได้ ถ้า fetch worklog เต็มของ task ไม่สำเร็จ ต้องเก็บ worklog เดิมใน local ไว้ (ห้ามเขียนทับด้วย `[]`)
- request ต่อ issue (worklog list) ถูกจำกัด concurrency ที่ 4 (`mapWithConcurrency`)
- Jira URL ต้องเป็น Atlassian Cloud (`*.atlassian.net`, https) — ตรวจใน Settings ด้วย `validateJiraInstanceUrl()`
- Theme ยังควบคุมแค่ DOM class; ไม่มี native Tauri theme bridge
- asset ฝั่ง mobile ใน `src-tauri/icons` เป็น artifact ของ Tauri tooling ไม่ใช่ target platform

## Useful commands

| Task       | Command                             |
| ---------- | ----------------------------------- |
| Dev server | `bun run dev` + `bun run tauri dev` |
| Tests      | `bun run test`                      |
| Lint       | `bun run lint`                      |
| Type check | `bun run build` (runs `tsc`)        |
| E2E        | `bun run test:e2e` (Playwright)     |

```bash
bun tauri dev
bun tauri build
bun lint
bun format
bun x vitest run
cargo check --manifest-path src-tauri/Cargo.toml
```

## E2E tests (Playwright)

- `bun run test:e2e` เปิด `vite --mode e2e` (port 1425) ที่ alias Tauri APIs ไปที่ `e2e/shims/*` และให้ Playwright จำลอง Jira ผ่าน `e2e/fake-jira.ts` — ไม่ต้องมี Tauri หรือ Jira จริง; ไฟล์ test ต้องชื่อ `*.e2e.ts` (กัน `bun test` หยิบไปรัน)
- ทุกการแก้ behavior ต้องมี test คู่ **positive + negative** (เช่น "ส่ง field ที่แก้" คู่กับ "ไม่ส่ง field ที่ไม่ได้แก้") และควรลอง mutate โค้ดย้อนกลับดูว่า test พังจริง
- เตรียม Chromium: `bun x playwright install chromium` (ต้องตรงกับเวอร์ชัน `@playwright/test` ที่ pin ไว้); type-check e2e: `bun x tsc --noEmit -p e2e/tsconfig.json`
- Rust (ขนาด window ขั้นต่ำ, capabilities) ทดสอบด้วย Playwright ไม่ได้ — ใช้ `bun run cg:check`

## Detailed Docs

- [Architecture](docs/architecture.md) — stack, data flow, ID scheme, sync strategy, Dexie schema
- [Technical Debt](docs/technical-debt.md) — fixed issues + remaining backlog with fix guidance

## Architecture Diagram

```
Jira API ──sync──► IndexedDB (Dexie) ──loadFromDB──► Zustand ──► React UI
                                                          ▲
                              local edits (isDirty=true) ─┘
                                                          │
                              syncAllDirtyTasks ──────────┘──► Jira API
```

## Known Remaining Debt

See [docs/technical-debt.md](docs/technical-debt.md#remaining) for details. The current backlog: verifying keychain/CSP in a packaged Tauri build (and Linux keychain support), the sync lock being held for a whole pull, silent non-push of `NA`/cleared values, the ms-resolution `updatedAt` edit detection, and the single TanStack Virtual lint suppression.

Resolved on 2026-10-09: OS keychain for API tokens, real CSP, versioned Dexie schema, incremental sync, direct sync-result updates, transition-aware status dropdown, local-only note, unused shadcn/ui + dependencies, Fast Refresh warning. Resolved on 2026-08-02: account-scoped indexed collection loading, duplicate task filtering, full reload after single-task sync, the missing app error boundary, and unused `@tanstack/react-query`.
