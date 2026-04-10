# JiraSync Hub — Agent Notes

## App in 1 minute

- Desktop app สำหรับ sync Jira tasks/worklogs มาทำงานในเครื่อง, แก้แบบ offline-first-ish, แล้ว push เฉพาะ task ที่ dirty กลับ Jira
- รองรับเฉพาะ `windows`, `linux`, `macos`
- Stack หลัก: Tauri 2, React 19, Vite 7, Tailwind + shadcn/ui, Zustand, Dexie, localStorage, Vitest

## Code map

- `src/App.tsx`: app shell, titlebar/resize handles, `HashRouter`
- `src/pages/Index.tsx`: main dashboard, sync/export/settings controls
- `src/store/task-store.ts`: source of truth ของ UI, dirty state, push ไป Jira
- `src/lib/sync-service.ts`: background pull sync ทุก 1 ชั่วโมง
- `src/lib/jira-api.ts`: Jira HTTP client + Jira -> local model mapping
- `src/lib/jira-db.ts`: Dexie + localStorage helpers
- `src/lib/jira-ids.ts`: account-scoped IDs
- `src/components/JiraSettings.tsx`: Jira accounts + story point field mapping
- `src/components/ExportDialog.tsx`: export CSV ผ่าน Tauri dialog/fs
- `src-tauri/src/lib.rs`: สร้าง main window และลง plugins

## Data / storage

- localStorage:
  - `jira-accounts`
  - `jira-settings` เป็น legacy key และ migrate อัตโนมัติ
  - `jira-story-point-fields` = `{ [projectId]: jiraCustomFieldId }`
- IndexedDB (`jira-task-manager`):
  - `organizations: "id, name"`
  - `projects: "id, orgId, jiraProjectKey"`
  - `tasks: "id, projectId, jiraTaskId, status, isDirty"`
  - `workLogs: "id, taskId, logDate"`
  - `syncMeta: "id"`
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
  - ส่ง story points, priority จาก severity, timetracking, และ Jira description จาก `task.note`
  - `mandays` ภายในระบบคิดเป็น decimal day โดย `1 = 8 ชั่วโมง`
  - severity map เป็น `Critical -> Highest`, `High -> High`, `Medium -> Medium`, `Low -> Low`

## Current product behavior

- แก้จาก UI ได้: status, type, severity, story level, mandays, note, worklogs
- `storyLevel` รับเฉพาะ `1 | 2 | 3 | 5`
- `task.description` เก็บ Jira description เดิม; ถ้าเป็น ADF จะเก็บเป็น JSON string เพื่อ render ด้วย `AdfRenderer`
- `task.note` เป็น field local แต่ตอน push จะเขียนกลับไปที่ Jira `description`
- Worklog ใช้ `syncStatus = synced | pending_create | pending_delete`
- Export CSV ใช้เฉพาะ worklogs ที่ยัง visible และเลือก export ตามเดือน
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

- อย่า hardcode story point field ใหม่ตรงๆ; ใช้ `getStoryPointFieldMap()[projectId] ?? "customfield_10016"`
- `JiraIssueFields` ต้องมี `[key: string]: unknown` เพื่อรองรับ dynamic custom fields
- `detectStoryPointCandidates()` ต้อง fail เงียบและ return `[]`
- mock `@/lib/jira-db` ใน Vitest ต้อง export `getStoryPointFieldMap`
- `removeJiraAccount()` ปัจจุบันลบ org/project/task/worklog ของ account นั้นออกจาก local DB แล้ว
- `sync-service.ts` ยัง persist เฉพาะ project ที่มี fetched issues; project ว่างจะไม่ถูกเก็บ
- `removeStaleProjectsForAccount()` ลบเฉพาะ project rows; tasks/worklogs เก่าของ project ที่หายไปอาจยังค้างใน Dexie แต่จะถูก filter ออกจาก UI
- Theme ยังควบคุมแค่ DOM class; ไม่มี native Tauri theme bridge
- asset ฝั่ง mobile ใน `src-tauri/icons` เป็น artifact ของ Tauri tooling ไม่ใช่ target platform

## Useful commands

```bash
bun tauri dev
bun tauri build
bun lint
bun format
bun x vitest run
cargo check --manifest-path src-tauri/Cargo.toml
```
