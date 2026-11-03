# แผน Agent Execution และ Personal Development Harness

วันที่: 2026-11-01  
สถานะ: ข้อเสนอสำหรับอ่านก่อน implement; ยังไม่ได้เพิ่ม runner, MCP หรือฐานข้อมูลใหม่  
ขอบเขตที่ผู้ใช้เลือก: ใช้ส่วนตัว คุม agent และงานในเครื่องก่อน

## 1. ข้อเสนอหลัก

ให้ JiraSync Hub เป็นหน้าควบคุมงาน: เลือก ticket → เลือก repo/agent → ตรวจแผน → รันใน worktree → ตรวจผล → review diff แล้วตัดสินใจจบงาน

เพิ่ม Run Manager ที่เรียก Claude Code/Codex ได้โดยตรงก่อน แล้วเพิ่ม MCP เป็นอีกช่องทางเข้าถึง Run Manager เดียวกัน; ไม่สร้าง agent loop หรือระบบ tools ของโมเดลขึ้นใหม่

| สิ่งที่ใช้ต่อ                    | สิ่งที่เพิ่ม                                      | สิ่งที่ยังไม่ทำ                            |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| หน้า Jira และ AI Board เดิม      | Repo binding, Doctor, Run panel และ native runner | ระบบบัญชีผู้ใช้/สิทธิ์ทีม/ศูนย์สั่งงานกลาง |
| Zustand store เดียว              | Policy, worktree, run journal และ verification    | หลาย agent เขียน worktree เดียวกัน         |
| Jira cache/note/worklog ใน Dexie | Adapter แยก Claude และ Codex                      | นำ Jira credentials ไปให้ agent            |
| AI status แยกจาก Jira            | หลักฐานของแต่ละ run และประวัติ retry              | Auto merge, deploy หรือ Jira transition    |

แอปควบคุมงานที่สั่งผ่าน runner ของมัน; ไม่ได้ห้ามเจ้าของเครื่องเปิด editor แก้ไฟล์เอง หากภายหลังต้องคุมการเข้า branch กลาง ให้เพิ่ม required CI/review และ branch protection เป็นอีกระยะ

## 2. หลักฐานจาก repo และเครื่องนี้

| จุดตรวจ                                        | พบอะไร                                                                                                                                                     | ผลต่อแบบ                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/App.tsx`                                  | ดูแล loading และ sync ข้าม page แล้ว                                                                                                                       | ผูก event subscription ของ runner กับอายุแอป ไม่เริ่มใหม่ทุกครั้งที่เปลี่ยนหน้า      |
| `src/store/task-store.ts`                      | มี board selection, AI progress และ summary actions อยู่แล้ว                                                                                               | เพิ่ม run actions/projection ใน store เดิม                                           |
| `src/lib/jira-db.ts`                           | Dexie v3 มี `aiBoardStates`                                                                                                                                | ไม่ย้าย Jira data เพื่อเริ่มรัน agent                                                |
| `src-tauri/src/lib.rs`                         | มี native commands แต่ยังไม่มี agent process supervisor                                                                                                    | เพิ่ม Rust runner; ไม่เปิด generic shell command ให้ WebView                         |
| capabilities/Cargo                             | process plugin ปัจจุบันใช้กับตัวแอป ไม่ใช่ coding-agent runner                                                                                             | ต้องออกแบบ native commands, process lifecycle และ permissions เพิ่ม                  |
| Codex CLI                                      | `codex-cli 0.166.0`; app-server help ตอบได้และมี stdio transport                                                                                           | provider ที่สอง ต่อด้วย contract เดียวกับ Claude                                     |
| Claude CLI                                     | 2026-11-03: `2.1.317 (Claude Code)` ทำงานแล้ว (ก่อนหน้าเคยล้มด้วย Bun remap error)                                                                         | เป็น provider แรก; Doctor ยังต้องตรวจการเริ่ม process จริง ไม่ใช่แค่หาไฟล์เจอ        |
| Worktree + deps (ทดลองกับ JS project ตัวอย่าง) | worktree ใหม่ `bun install --frozen-lockfile` = 22s (447 packages, cache อุ่น); junction `node_modules` แล้ว `tsc`, `vitest` (116 pass), `vite build` ผ่าน | ตัดสินใช้ install จริงทุก run (หัวข้อ 7.1); link ทำได้แต่เสี่ยงกับ workspace/codegen |
| Windows path                                   | (ทดลองเดียวกัน) ลบ worktree ที่ install `node_modules` จริงใต้ path ยาวไม่ได้ (`Filename too long`)                                                        | worktree root ต้องสั้นและตั้ง `core.longpaths=true`                                  |

การตรวจนี้ไม่ได้เริ่ม agent session, แก้การติดตั้ง Claude หรือเรียกโมเดลที่มีค่าใช้จ่าย

## 3. UX ที่เพิ่มในหน้า AI Board

| จุดใช้งาน                        | พฤติกรรม                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ปุ่ม **Setup** ขวาบนของ AI Board | รวมการตั้งค่า harness ไว้ที่เดียว: Repository bindings, คำสั่ง install/build/test/dev, ไฟล์ env + overrides, Docker services, Agent (Doctor) |
| ครั้งแรกที่เปิด AI Board         | รัน Doctor อัตโนมัติ (Git, Claude CLI, Docker) แล้วพาไปหน้า Setup ถ้ายังไม่พร้อม; ไม่บล็อกการใช้บอร์ดแบบ manual                              |
| Setup → Repository               | เลือก local repo, base branch, worktree root, คำสั่งที่ตรวจพบ และไฟล์ env ที่จะ copy; จดจำ mapping ต่อ project                               |
| Setup → Docker                   | แสดง endpoint ที่อ่านจาก Docker context ปัจจุบัน (override ได้), version และสถานะเชื่อมต่อ                                                   |
| Setup → Agent (Doctor)           | แสดง CLI path/version, auth readiness, Git, sandbox capabilities และสาเหตุที่ Run ยังไม่ได้                                                  |
| Ticket detail → Plan with…       | เลือก Codex/Claude และแสดง context ที่จะส่ง; local note ยัง opt-in                                                                           |
| Plan review                      | แสดงสิ่งที่จะเปลี่ยน, ขอบเขตไฟล์, checks และ budget; แก้โจทย์หรือ Approve & Run ได้                                                          |
| Run panel                        | แท็บ Activity, Diff, Checks, Approvals; ดู provider/session/worktree ที่กำลังใช้                                                             |
| Stop                             | ขอ interrupt แล้วหยุด process tree ตาม timeout; เก็บ diff/log เพื่อเปิดดูต่อ                                                                 |
| Review                           | แสดง actual diff และผล checks ของ revision เดียวกัน; เลือกให้แก้ต่อหรือ Accept                                                               |
| Retry / Continue                 | ใช้ task/worktree/session ที่ระบุชัด; retry เป็น attempt ใหม่ ไม่เรียก run ซ้ำโดยไม่รู้ตัว                                                   |

คง sidebar, search, light/dark, hide space และลูกศร My Work ในตำแหน่งปัจจุบัน ไม่เพิ่มหน้า chat มาแทนบอร์ดหรือย้าย controls ของ Jira

รุ่นแรกอนุญาตหนึ่ง active run ทั้งแอป; เปลี่ยน page ไม่หยุดงาน ปิดหน้าต่างระหว่างรันให้เลือกกลับไปดูงานหรือ Stop & Close; ยังไม่ทำ background daemon

## 4. Workflow และสถานะ

```mermaid
flowchart LR
    Task[เลือก ticket ที่พร้อมทำ] --> Doctor[ตรวจ repo และ provider]
    Doctor --> Worktree[สร้าง worktree เฉพาะ run]
    Worktree --> Plan[Agent เสนอแผน]
    Plan --> Approval{เจ้าของอนุมัติแผน}
    Approval -->|แก้โจทย์| Plan
    Approval -->|อนุมัติ| Execute[Agent ลงมือใน worktree]
    Execute --> Verify[Harness รัน checks จริง]
    Verify -->|ไม่ผ่านและยังมี budget| Repair[เสนอรอบแก้]
    Repair --> Execute
    Verify -->|ผ่าน| Review[ตรวจ diff และหลักฐาน]
    Review -->|ขอแก้| Execute
    Review -->|Accept| Publish[commit, push, PR] --> Done[AI Done]
```

| Run state                                       | ความหมาย                                              | AI Board                                      |
| ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `preparing`, `planning`, `running`, `verifying` | มีงานกำลังดำเนินการ                                   | Doing                                         |
| `awaiting_plan`, `awaiting_permission`          | รอคำตอบเจ้าของ                                        | Doing พร้อม badge ที่บอกสิ่งที่รอ             |
| `ready_for_review`                              | agent จบและ checks ผ่าน แต่ยังไม่รับงาน               | Review                                        |
| `completed`                                     | เจ้าของ Accept, หลักฐานตรงกับ diff และ push/PR สำเร็จ | Done                                          |
| `failed`, `cancelled`, `interrupted`            | หยุดพร้อมเก็บสาเหตุและ artifact                       | ไม่ตีเป็น Done; แสดง badge และเลือก retry ได้ |

- Process exit 0 หรือข้อความว่าเสร็จไม่ทำให้ AI Done เอง
- งานที่ Jira Done ยังบังคับ AI Done/ซ่อนตามเดิม; ถ้ามี run ให้ขอ Stop, ปิดสิทธิ์เริ่ม/ส่งงานต่อ และเก็บผลไว้ใน Run history
- ถ้า Jira เปิดใหม่ ให้แสดงตาม progress เดิม แต่ไม่ resume process อัตโนมัติ
- Manual AI Done เดิมยังใช้ได้ แต่ต้องบันทึกว่าเป็น manual completion ไม่สร้างผล checks ปลอมให้ run

## 5. เลือกวิธีเชื่อมต่อ provider

| Provider/วิธี                    | ใช้ทำอะไร                                                                          | ข้อจำกัดที่ต้องแสดง                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Codex app-server ผ่าน stdio      | ทางหลัก: stream events, session, interrupt และตอบ approval request                 | CLI ที่ติดตั้งอาจใช้ schema ต่างกัน ต้องตรวจ version/capabilities                            |
| Codex exec                       | งานครั้งเดียวหรือ spike แบบมีขอบเขต                                                | ไม่ใช้แทน interactive approval ของ app-server                                                |
| Claude Code CLI ที่ผู้ใช้ติดตั้ง | ทางเริ่มสำหรับ personal automation: headless run, structured events และ session ID | กติกา non-interactive อาจ deny tool แทนการถาม; ห้ามแสดงว่ารองรับ live approval เท่ากับ Codex |
| Claude Agent SDK sidecar         | ทางเต็มเมื่ออยากตอบ permission/user-input ผ่าน UI                                  | ต้องพิสูจน์ packaging, auth และ hook behavior ก่อนเปิด capability นี้                        |

ข้อเท็จจริงของ Codex app-server อ้างอิง [OpenAI Docs](https://learn.chatgpt.com/docs/app-server); Claude CLI อ้างอิง [programmatic usage](https://code.claude.com/docs/en/headless) และ [CLI reference](https://code.claude.com/docs/en/cli-reference)

รุ่นแรกทำ vertical slice ด้วย Claude Code CLI ที่ผู้ใช้ติดตั้งให้ครบก่อน แล้วต่อ Codex ด้วย contract เดียวกัน; Claude headless จะ deny tool ที่ไม่ได้อนุญาตแทนการถาม จึงต้องกำหนด allowed/disallowed tools ใน policy ที่อนุมัติตอนเริ่ม run; ฟังก์ชันที่ provider ไม่รองรับต้องปิดพร้อมเหตุผล ไม่เงียบแล้วเปลี่ยนเป็น bypass mode

### Auth และการแจกจ่าย

- เริ่มจาก CLI ที่ผู้ใช้ติดตั้งเองและ flow sign-in ของ provider; ไม่อ่านหรือคัดลอก session token มาเก็บใน JiraSync
- ไม่สรุปว่า Claude subscription login ใช้กับ embedded Agent SDK ได้เหมือน CLI; SDK integration ควรใช้ API key/ผู้ให้บริการที่รองรับตาม [คำแนะนำ Anthropic](https://code.claude.com/docs/en/legal-and-compliance)
- ถ้าเพิ่ม API key ให้เก็บใน OS credential store และส่งเฉพาะ process ที่ต้องใช้; ไม่ใส่ใน prompt, frontend, TOML, log หรือ export
- ทางเลือก sidecar คือ TypeScript + Bun compiled executable; ต้องทดสอบการจัดวาง native Claude binary ทุก platform ตาม [SDK packaging documentation](https://code.claude.com/docs/en/agent-sdk/typescript#compile-to-a-single-executable) ก่อนสัญญาว่าผู้ใช้ไม่ต้องติดตั้ง runtime
- ไม่ hardcode model หรือราคา; ใช้สิ่งที่ adapter ตรวจพบและแสดงเมื่อ usage/cost ไม่ทราบค่า ไม่แสดงเป็น 0

## 6. Architecture ที่เข้ากับ Tauri ปัจจุบัน

```mermaid
flowchart TB
    Jira[Jira sync เดิม] --> Dexie[Dexie: tasks notes worklogs AI status]
    Dexie --> Store[task-store.ts]
    UI[AI Board และ Run panel] --> Store
    Store --> Client[Typed harness client]
    Client --> Core[Rust Harness Core]
    Core --> Repo[Repo และ worktree manager]
    Core --> Policy[Policy และ approval broker]
    Core --> Providers[Codex / Claude adapters]
    Core --> Journal[Native run journal และ artifacts]
    Providers --> Events[Normalized events]
    Events --> Core
    Core -->|batched events| Store
    MCP[MCP clients ในระยะถัดไป] -.-> Core
```

| ชั้น                | หน้าที่                                                                  | ไม่ทำ                                                              |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| React               | แสดง run/diff/approval/checks                                            | spawn process หรือยิง Jira จาก component                           |
| Zustand เดิม        | async actions, UI state, apply event และ persist AI projection           | สร้าง store แยกหรือเก็บ transcript ทั้งหมดใน state                 |
| Rust core           | typed commands, process supervision, locks, durable run state และ policy | เชื่อ executable/path/arguments ที่ agent หรือ WebView ส่งมาโดยตรง |
| Provider adapter    | แปลง start/stream/stop/session/approval ให้เป็น contract กลาง            | ตัดสินเองว่า task ผ่าน acceptance criteria                         |
| Verification runner | รัน command ที่เจ้าของตั้งไว้และบันทึก exit/output/revision              | ใช้คำกล่าวของโมเดลเป็นผล test                                      |

Native commands รับ `taskRef`, `repoBindingId`, `provider`, `runId` และตัวเลือกที่ตรวจ schema แล้ว; ไม่เปิด `execute_any_command(commandString)` ให้ frontend หรือ MCP

### ข้อมูลใครเป็นเจ้าของ

| ข้อมูล                                            | เจ้าของข้อมูลหลัก                                 | เหตุผล                                                                   |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Jira task/project/worklog/note/AI manual progress | Dexie เดิม                                        | รักษา offline-first และ sync behavior เดิม                               |
| Repo binding และ personal harness settings        | native app-data config                            | ไม่ใส่ absolute machine path ลง repo กลาง                                |
| Run/attempt/session/approval/check metadata       | Native SQLite journal                             | กู้คืน execution state หลัง crash โดยไม่พึ่ง WebView                     |
| Log/diff/ผลตรวจขนาดใหญ่                           | ไฟล์ใน app-data อ้างอิงด้วย artifact ID           | ไม่ยัด log ทุก token เข้า IndexedDB/Zustand                              |
| Snapshot โจทย์สำหรับ run                          | immutable artifact พร้อม digest และ task revision | บอกได้ว่า agent ได้รับโจทย์ฉบับไหน; ไม่เป็น task copy ที่ sync กลับ Jira |

SQLite ใหม่นี้เป็น run journal ไม่ใช่การย้ายทั้ง Jira Board ออกจาก Dexie; UI ทั้งหมดยังผ่าน store เดิม การทำ native shared board แบบ headless ต้องมี ADR/migration แยกก่อน

ตัวอย่างโฟลเดอร์ของแอป:

```text
<app-data>/harness/
  bindings.json        # repo bindings (Phase 1 เก็บเป็น JSON; ไม่ต้องเพิ่ม TOML parser)
  runs.sqlite
  runs/<run-id>/context.md
  runs/<run-id>/events.ndjson
  runs/<run-id>/checks/<check-id>.log
  runs/<run-id>/changes.diff
```

Metadata/event sequence ใน SQLite เป็น canonical journal; NDJSON เป็น log artifact ที่ replay/import มาเขียน state เองไม่ได้ ไฟล์ทั้งหมดอาจมี source/private context ต้องมี retention และปุ่มลบที่บอกสิ่งที่จะหาย

## 7. Harness ต้องคุมอะไรจริง

| จุดคุม       | ค่าเริ่มต้นส่วนตัว                                                     | สิ่งที่ตรวจได้                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo         | local repo ที่เลือกและ base SHA ที่บันทึกไว้                           | canonical path และ Git root ตรง binding                                                                                                                      |
| Workspace    | หนึ่ง run ต่อหนึ่ง worktree                                            | ไม่แก้ checkout ที่ dev เปิดอยู่; ไม่มีการ stash/reset งานเดิม                                                                                               |
| Plan gate    | อนุมัติ scope/checks/budget ครั้งหนึ่งก่อน implement                   | approval ผูก context hash, policy hash และ run attempt                                                                                                       |
| Permissions  | ใช้ขอบเขตของ provider; ไม่ใช้ bypass เป็น default                      | capability ที่ใช้ได้/ไม่ได้ต้องเห็นใน Doctor                                                                                                                 |
| Budget       | 30 นาทีของ **เวลาที่ AI ทำงาน**, 1 active run, เสนอแก้ได้ไม่เกิน 2 รอบ | นาฬิกาหยุดระหว่างแอป execute (`harness.run`, install, services, migrate, checks) และระหว่างรอเจ้าของตอบ; ใช้ `--max-budget-usd` คุมเงินเมื่อ provider รองรับ |
| Stop         | interrupt ก่อน แล้ว terminate process tree                             | ทดสอบ Windows Job Objects และ process group บน macOS/Linux                                                                                                   |
| Verification | commands ที่เจ้าของกำหนด                                               | exit code, timeout, output และ diff revision จริง                                                                                                            |
| Review gate  | เจ้าของ Accept ก่อน Done                                               | diff เปลี่ยนหลังตรวจเมื่อใด หลักฐาน/approval เก่าหมดอายุ                                                                                                     |
| Publish      | Accept = commit, push, PR (หัวข้อ 7.3)                                 | ไม่ merge/deploy; push/PR เกิดหลัง Accept เท่านั้น                                                                                                           |

คำสั่ง checks ตั้งเป็น executable + args ไม่ต่อ shell string จาก ticket; ใช้ไฟล์ policy ที่อนุมัติตอนเริ่ม ไม่เอา config ที่ agent เพิ่งแก้มาเปลี่ยนสิทธิ์ระหว่าง run

ก่อนสร้าง worktree แอปรัน `git fetch origin <base>` แล้วเริ่มจาก `origin/<base>` ล่าสุด (บันทึก SHA นั้นเป็น base ของ run) ไม่ใช้ branch base ในเครื่องที่อาจค้างอยู่หลัง remote; ถ้า checkout เดิมมี WIP ให้แสดงว่าข้อมูลนั้นไม่ถูกรวม ไม่คัดลอกไฟล์หรือ uncommitted patch ไปเงียบ ๆ ชื่อ branch/path สร้างจาก run ID ที่ตรวจแล้ว ไม่ใช้ title เป็น path

### ขอบเขตการคุมที่ต้องบอกตรง ๆ

- Worktree แยกงานได้ แต่ไม่ใช่ security sandbox; process ที่มีสิทธิ์เต็มของผู้ใช้ยังอาจเข้าถึงไฟล์อื่นได้
- Prompt, command-prefix rules และ deny regex ไม่ใช่การป้องกันการ bypass ผ่าน shell แบบสมบูรณ์
- หน้า Doctor แยก managed local run กับ OS-isolated run; ถ้าขอ isolated แต่ platform/provider ทำไม่ได้ ต้องปฏิเสธการเริ่ม ไม่ลดระดับเงียบ ๆ
- แยก environment ที่จำเป็นจาก parent process; ไม่ส่ง Jira token, GitHub token หรือ secret อื่นให้ agent แบบเหมารวม
- ตรวจ hooks/plugins/MCP config ที่อาจรันตั้งแต่ startup ก่อน trust repo; instruction files เป็น context ไม่ใช่สิทธิ์เพิ่ม
- สำหรับ Claude SDK การตรวจทุก tool ต้องใช้ hook ที่เหมาะสม ไม่อาศัย `canUseTool` อย่างเดียวเพราะบาง call ถูกอนุมัติก่อนถึง callback ตาม [permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions)

### 7.1 Workspace และคำสั่งที่แอปเป็นคน execute

ใช้กับ **repo ปลายทางที่ task ผูกไว้** (repo/โฟลเดอร์ใดก็ได้ในเครื่อง ภาษาใดก็ได้) ไม่ใช่ repo ของ JiraSync เอง; "base repo" หมายถึง checkout ของ repo ปลายทางที่ dev ใช้อยู่

หลักการ: คำสั่ง **install, build, test, dev** ของ repo ปลายทาง แอปเป็นคน execute เสมอ และแสดง process/output สดใน Run panel; AI ไม่รันคำสั่งเหล่านี้เองผ่าน shell เพื่อให้เจ้าของเห็นว่าเกิดอะไรขึ้นจริง ไม่ใช่ดูแค่สิ่งที่ AI เล่า และไม่เปลือง token กับ output ยาวของ install

```mermaid
flowchart LR
    Start[Start workflow ของ task] --> Bind[อ่าน repo binding ของ task]
    Bind --> WT[สร้าง worktree ของ repo ปลายทางจาก base SHA]
    WT --> Env[copy ไฟล์ env ที่เลือกจาก base repo]
    Env --> Install[แอปรัน install จริงใน worktree]
    Install -->|fail| Stop[หยุด: แสดง log, ไม่เริ่ม AI]
    Install -->|ผ่าน| Agent[เริ่ม AI โดย cwd = worktree]
    Agent -->|ขอรัน build/test/dev| App[แอป execute และแสดงผลสด]
    App -->|ผลย่อ| Agent
    Agent --> Diff{manifest/lockfile เปลี่ยน?}
    Diff -->|ใช่| Reinstall[แอปรัน install ใหม่] --> Verify
    Diff -->|ไม่| Verify[แอปรัน checks สุดท้าย]
```

| เรื่อง               | กติกา                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency           | install จริงใน worktree ทุก run ไม่ link `node_modules`/`.venv`/build output; ความเร็วเป็นหน้าที่ของ package manager/cache ของเครื่อง                                                                                                                                                                                                                             |
| `.env`               | copy จาก base repo ตอนสร้าง worktree เฉพาะไฟล์ที่เลือกใน binding (เช่น `.env`, `.env.local`); เป็น snapshot ไม่ sync ตาม base repo ระหว่าง run และลบพร้อม worktree                                                                                                                                                                                                |
| ความลับใน `.env`     | AI อ่านได้ (ผ่าน shell หรือ process env) ถือว่าเห็น; Run panel แสดงชื่อไฟล์ที่ copy ไม่แสดงค่า และ log ที่เก็บต้อง mask ค่าจาก `.env`                                                                                                                                                                                                                             |
| คำสั่งที่แอป execute | `install`, `build`, `test`, `dev` (และ `lint` ถ้ามี) ตั้งเป็น executable + args ต่อ repo binding ภาษาใดก็ได้                                                                                                                                                                                                                                                      |
| การแสดงผล            | แต่ละคำสั่งเป็นแถวใน Run panel: ใครสั่ง (แอป/AI ขอ/เจ้าของ), command, cwd, เวลา, สถานะ, exit code, output สดแบบ stream และกด Stop ได้; เก็บ log เป็น artifact ของ run                                                                                                                                                                                             |
| AI ขอรันระหว่างทำงาน | ผ่าน MCP tool ของแอป `harness.run({ command: "build" \| "test" \| "lint" \| "dev" \| "hurl", files? })` เท่านั้น รับชื่อคำสั่งที่อยู่ใน binding ไม่รับ command string; แอป execute และแสดงสด                                                                                                                                                                      |
| เรียก HTTP API       | ไม่มี `curl`; AI เขียนไฟล์ `.hurl` ใน worktree (เช่น `.harness/http/*.hurl`) แล้วขอ `harness.run({ command: "hurl", files })` แอปรัน `hurl --test --variable base_url=http://127.0.0.1:<dev port> --report-json <artifact>` และส่งผลย่อกลับ                                                                                                                       |
| Git แบบอ่าน          | MCP tool `harness.git({ op: "status" \| "diff" \| "log" \| "show" })` อ่านอย่างเดียว; commit/push เป็นหน้าที่ของแอปตอน Accept                                                                                                                                                                                                                                     |
| สิ่งที่ AI ได้รับ    | สถานะ + exit code + output ส่วนท้าย/ส่วน error ที่ตัดแล้ว ไม่ส่ง log เต็มกลับเข้า context; อ่านต่อได้ด้วย `harness.get_log` แบบแบ่งหน้า                                                                                                                                                                                                                           |
| `dev`                | เปิดเมื่อเจ้าของกดปุ่มหรือ AI ขอผ่าน tool เท่านั้น ไม่เปิดอัตโนมัติ; ผูกกับ run, ใช้ port ที่แอปจองให้ และปิดเมื่อ run จบหรือ Stop                                                                                                                                                                                                                                |
| สิทธิ์ AI            | AI **ไม่มี shell**: Claude รันด้วย `--restricted --tools "Read,Glob,Grep,Edit,Write" --disable-slash-commands --strict-mcp-config --mcp-config <harness> --permission-prompt-tool mcp__harness__approve` จึงอ่าน/ค้น/เขียนไฟล์ใน worktree ได้เอง ส่วนการ execute ทุกอย่างต้องผ่าน `harness.run`; เป็นการตัด tool ออกจริง ไม่ใช่ deny regex (ยืนยันแล้วใน Phase 0) |
| Approval broker      | ใต้ `--restricted` คำสั่ง `--allowedTools`/`--settings` อนุญาต MCP tools ไม่ได้ ต้องให้แอปตอบผ่าน `--permission-prompt-tool` เท่านั้น: อนุญาต `harness.*`, ปฏิเสธการเขียน `.git`, `.claude/`, `.mcp.json`; ทุกการตัดสินบันทึกใน journal                                                                                                                           |
| Skill                | ใช้ `--disable-slash-commands` แล้ว init ไม่มี skill ของ Claude Code เลย (list ว่าง); AI เรียก `skill_list` → `skill_get harness` จากแอปเอง แล้ววางไฟล์ที่ `.harness/http/*.hurl` และใช้ `{{base_url}}` ตาม skill                                                                                                                                                 |
| Cleanup              | ลบ worktree พร้อม `.env` ที่ copy และ dependency ที่ install; worktree ที่มีงานยังไม่ commit ต้องให้เจ้าของยืนยัน                                                                                                                                                                                                                                                 |
| Path                 | worktree root สั้นและเป็นค่าของแอป เช่น `<drive>:\wt\<run-id>` และตั้ง `core.longpaths=true` (install จริงใต้ path ยาวทำให้ลบ worktree ไม่ได้บน Windows)                                                                                                                                                                                                          |

#### ตรวจหาคำสั่งต่อ repo binding

ตรวจครั้งเดียวตอนผูก repo กับ project (หรือเมื่อชุด manifest/lockfile ของ repo นั้นเปลี่ยน) ไม่ตรวจใหม่ทุก run; แต่ละ repo/เครื่องได้คำสั่งต่างกันได้ เช่น repo หนึ่ง `npm ci` อีก repo `bun i`:

1. ตรวจแบบ deterministic จากไฟล์ใน repo ปลายทางก่อน (ไม่ใช้ token): lockfile → install, scripts ใน manifest → build/test/dev
2. ถ้าไม่ตรงกฎไหน, lockfile ขัดกัน หรือเป็น monorepo หลายภาษา ค่อยให้ AI อ่าน repo แบบ read-only แล้ว **เสนอ** คำสั่งและไฟล์ env ที่ต้อง copy
3. เจ้าของแก้/อนุมัติ แล้วเก็บใน binding ของเครื่องนั้น; ทุก run ใช้ตามที่บันทึกไว้ โดยไม่ถาม AI อีก
4. Doctor ตรวจว่า executable ที่บันทึก (เช่น `bun`, `npm`, `cargo`, `uv`) มีอยู่จริงบนเครื่องนั้น

| พบไฟล์ใน repo ปลายทาง                              | install                                                       | build / test / dev ที่เสนอ                      |
| -------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `bun.lock` / `bun.lockb` / `packageManager: bun@…` | `bun install --frozen-lockfile`                               | `bun run <script>` จาก `package.json`           |
| `package-lock.json`                                | `npm ci`                                                      | `npm run <script>`                              |
| `pnpm-lock.yaml`                                   | `pnpm install --frozen-lockfile`                              | `pnpm run <script>`                             |
| `yarn.lock`                                        | `yarn install --immutable` (Berry) / `--frozen-lockfile` (v1) | `yarn <script>`                                 |
| `Cargo.lock` / `Cargo.toml`                        | `cargo fetch`                                                 | `cargo build` / `cargo test` / `cargo run`      |
| `go.mod`                                           | `go mod download`                                             | `go build ./...` / `go test ./...` / `go run .` |
| `uv.lock` / `pyproject.toml`                       | `uv sync`                                                     | ให้เจ้าของระบุ (เช่น `uv run pytest`)           |
| อื่น ๆ (Gradle, Maven, .NET ฯลฯ)                   | ให้ AI เสนอ                                                   | ให้ AI เสนอ                                     |

### 7.2 `.env` และ services ผ่าน Docker

เป้าหมาย: run ของ AI ไม่แตะ DB/port/service ที่เจ้าของใช้อยู่ใน base repo

**ตอนผูก repo (ครั้งเดียว ต่อ repo)**

1. แอปเทียบ `.env.example` (หรือ `.env.sample`/`.env.template`) กับ `.env` ของ base repo แบบ deterministic: key ที่ขาด, key ที่ดูเป็น service (`*_URL`, `*_HOST`, `*_PORT`, `PORT`, `DATABASE_*`, `REDIS_*` ฯลฯ)
2. ถ้ามี `docker-compose*.yml`/`compose*.yml`: แอป parse แล้ว**ดึงเฉพาะ services ที่ env keys ต้องใช้** (รวม `depends_on` ของมัน) แปลงเป็นค่าสำหรับ Docker Engine API เอง ไม่เรียก `docker compose` CLI
3. ถ้าไม่มี compose หรือ map ไม่ได้ ให้ AI อ่าน `.env.example` และ README แบบ read-only แล้ว **เสนอ** services (image, port, env เริ่มต้น, healthcheck); AI ได้แค่ชื่อ key ไม่ได้ค่าจริงใน `.env`
4. หาวิธี migrate DB (หัวข้อ "Migration" ด้านล่าง)
5. เจ้าของแก้/อนุมัติใน Setup → Repository แล้วบันทึกใน binding

**Compose subset ที่รองรับ**: `image`, `environment`/`env_file`, `ports`, `command`/`entrypoint`, `healthcheck`, named volumes, `depends_on` (condition `service_healthy`); service ที่ใช้ `build:` หรือ feature อื่นที่แปลงไม่ได้ ให้แสดงใน Setup ว่าไม่รองรับและให้เจ้าของเลือก image แทน ไม่ข้ามเงียบ ๆ

**Migration**: ตรวจตามลำดับแล้วบันทึกผลใน binding

1. แอป migrate เองตอน start อยู่แล้ว (AI ตรวจโค้ด startup เช่นเรียก migrate ใน `main`) → ไม่ต้องทำอะไร แต่ต้องรอ service ของแอปขึ้นก่อน checks
2. มีคำสั่ง migration ใน repo (เช่น script `migrate`/`db:migrate` ใน manifest, `prisma migrate deploy`, `alembic upgrade head`, `goose up`, `sqlx migrate run`, `rails db:migrate`) → บันทึกเป็น `commands.migrate` ที่แอป execute หลัง services healthy และก่อน install เสร็จ/AI เริ่ม
3. หาไม่เจอ → **ถามเจ้าของใน Setup** แล้วจดคำตอบไว้ใน binding (รวมกรณี "ไม่ต้อง migrate"); ไม่ถามซ้ำทุก run

**ตอน Start workflow (ทุก run)**

```mermaid
flowchart LR
    Copy[copy .env จาก base repo] --> Svc[แอปสร้าง containers ผ่าน Docker API]
    Svc --> Health[รอ healthcheck]
    Health --> Patch[เขียน overrides ลง .env ของ worktree]
    Patch --> Install[install]
    Install --> Migrate[migrate ถ้า binding กำหนด]
    Migrate --> Agent[เริ่ม AI]
```

ความลับใน `.env` ที่ copy มา: ยอมรับว่า AI อ่านได้ (ตัดสินแล้ว); log ที่แอปเก็บ/แสดงยัง mask ค่า

| เรื่อง          | กติกา                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker endpoint | อ่านจาก Docker context ปัจจุบันของเครื่อง (เช่น `tcp://127.0.0.1:<port>` ที่ port อาจเปลี่ยน) และ override ได้ใน Setup; ไม่ hardcode               |
| เรียกจากไหน     | Rust core เรียก Docker Engine API ผ่าน TCP/named pipe/unix socket; ไม่เปิด Docker ให้ WebView หรือ AI เรียกตรง                                     |
| ความปลอดภัย     | รับเฉพาะ endpoint loopback หรือ TLS; Docker API = สิทธิ์ระดับ root ของ VM จึงไม่ให้ AI สร้าง container เอง มีแต่ services ที่อนุมัติใน binding     |
| Container       | ติด label `jirasync.run=<run-id>`, ชื่อจาก run ID, host port สุ่มที่ว่าง, volume ชั่วคราวต่อ run; ไม่ใช้ชื่อ/volume เดียวกับ compose ของ base repo |
| Overrides       | แทนค่าเช่น `DATABASE_URL`, `REDIS_URL`, `PORT` ด้วย host/port ของ container ของ run; key อื่นคงค่าจาก base repo                                    |
| แสดงผล          | Run panel มีแถว Services: image, สถานะ, port, healthcheck และ log ของ container; ค่าความลับถูก mask                                                |
| Cleanup         | run จบ/Stop: หยุด container; ลบ container + volume ตอน cleanup worktree; ตอนเปิดแอปหา container ที่ label ของ run ที่ไม่มีแล้วและเสนอให้ลบ         |
| Docker ไม่พร้อม | ถ้า binding ต้องใช้ services แต่เชื่อม Docker ไม่ได้ ให้หยุดก่อนเริ่ม AI พร้อมเหตุผล ไม่ fallback ไปใช้ DB ของ base repo เงียบ ๆ                   |

### 7.3 Accept → Commit, Push และ Create PR

เมื่อเจ้าของกด **Accept** แอป commit, push และเปิด **Draft PR** ให้ทันที (ไม่ merge; ต้องรอ CI/CD ผ่านก่อนจึง Ready) ตามกติกาเดียวกับ skill `github:pr-rewrite`; แอปเป็นคน execute `git`/`gh` และแสดงทุกคำสั่งใน Run panel AI แค่ร่างข้อความ

```mermaid
flowchart LR
    Accept[เจ้าของกด Accept] --> Gate{diff/checks ยังเป็น revision เดียวกัน?}
    Gate -->|ไม่| Recheck[รัน checks ใหม่]
    Gate -->|ใช่| Draft[AI ร่าง commit + PR จาก diff จริง]
    Draft --> Edit[เจ้าของแก้/ยืนยันร่าง]
    Edit --> Commit[แอป git commit]
    Commit --> Push[แอป git push -u origin branch]
    Push --> Exists{มี PR ของ branch แล้ว?}
    Exists -->|ไม่| Create[gh pr create --draft]
    Exists -->|ใช่| Update[gh pr edit]
    Create --> Done[AI Done + บันทึก PR URL]
    Update --> Done
    Done --> CI{CI checks ของ PR}
    CI -->|ผ่านหมด| Ready[ปุ่ม Ready for review → gh pr ready]
    CI -->|fail| Fix[แสดง check ที่ fail; เลือก Continue run ให้ AI แก้]
```

| เรื่อง             | กติกา                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch             | สร้างตอนเริ่ม run เป็น `ai/<ISSUE-KEY>-<short-run-id>` ตั้งจาก ID ที่ตรวจแล้ว ไม่ใช้ title; base = base branch ของ binding                                                                               |
| Commit message     | ภาษาอังกฤษ conventional commit (`feat:`, `fix:` …) อ้าง issue key; ไม่มี AI-attribution footer                                                                                                           |
| PR title           | ภาษาอังกฤษ conventional commit; ไม่แปลเป็นไทย                                                                                                                                                            |
| PR body            | ภาษาไทยทั้ง template (`## สรุป`, `## เหตุผล`, `## การเปลี่ยนแปลง`, `## การทดสอบ`, `## ผลกระทบ`, `## ที่เกี่ยวข้อง`), สั้นเป็น bullet, ตัด section ที่ว่าง; ไม่มี AI-attribution                          |
| ที่มาของเนื้อหา    | ทุก bullet ต้องอ้างได้จาก commit/diff จริงที่แอปส่งให้ AI; ไม่มีหลักฐานให้ตัดทิ้ง                                                                                                                        |
| `## การทดสอบ`      | **แอปเติมเอง** จาก run journal: `[x]` เฉพาะคำสั่งที่แอป execute ผ่านบน revision นี้ (พร้อมชื่อคำสั่ง), ที่ไม่ได้รันเป็น `[ ]`; AI ห้ามติ๊กเอง                                                            |
| `## ผลกระทบ`       | DB migration = มี ถ้า diff แตะไฟล์ migration; Config change = มี ถ้าแตะ `.env.example`/config; ค่าที่ตัดสินไม่ได้ให้เจ้าของเลือกในหน้าร่าง                                                               |
| `## ที่เกี่ยวข้อง` | ลิงก์ Jira ของ task (`<instance>/browse/<KEY>`)                                                                                                                                                          |
| PR ซ้ำ             | เช็ก `gh pr list --state all --search "head:<branch>"` ก่อน; มีแล้วให้ edit ไม่สร้างใหม่ ถ้า merged ไปแล้ว (รวม squash merge) แจ้งเจ้าของแทน                                                             |
| Auth               | ใช้ `git` credential และ `gh auth` ของเครื่อง; Doctor ตรวจ `gh auth status` และ remote; ไม่ส่ง GitHub token ให้ AI                                                                                       |
| ล้มกลางทาง         | แต่ละขั้น (commit/push/PR) idempotent และ retry ได้จากขั้นที่ล้ม; ถ้า push ไม่ได้ run ยังเป็น Review ไม่เป็น Done                                                                                        |
| หลัง PR            | บันทึก PR URL ใน run และแสดงบนการ์ด; เสนอ cleanup worktree/containers เพราะโค้ดอยู่บน remote แล้ว; ไม่ transition/comment Jira อัตโนมัติ                                                                 |
| Draft → Ready      | แอปดูสถานะด้วย `gh pr checks <n>` (poll เป็นระยะขณะแอปเปิด); เปิดปุ่ม Ready for review เมื่อ checks ผ่านทั้งหมดเท่านั้น แล้วรัน `gh pr ready <n>`; ไม่มี CI = แสดงว่าไม่มี checks และให้เจ้าของตัดสินเอง |

## 8. Repo policy และหลักฐาน

เริ่มด้วย policy ที่เลือกผ่าน UI และ freeze ต่อ run; รองรับ `harness.toml` ใน repo เป็นขั้นถัดไป โดยแก้ policy แล้วต้องแสดง diff และรับรองฉบับใหม่ ไม่อ่านค่าที่เปลี่ยนแล้วใช้ทันที

ตัวอย่าง schema ที่เสนอ ไม่ใช่ config ที่แอปอ่านได้แล้ว:

```toml
version = 1
base_branch = "main"
require_plan_approval = true
require_review = true
max_runtime_seconds = 1800
max_repair_attempts = 2

[workspace]
copy_env = [".env", ".env.local"]   # copy จาก base repo ตอนสร้าง worktree
env_overrides = { PORT = "{run.port}", DATABASE_URL = "postgres://app:app@127.0.0.1:{services.db.port}/app" }

[services.db]   # แอปสร้างผ่าน Docker API ต่อ run
image = "postgres:16"
port = 5432
env = { POSTGRES_USER = "app", POSTGRES_PASSWORD = "app", POSTGRES_DB = "app" }
healthcheck = ["pg_isready", "-U", "app"]

# แอปเป็นคน execute ทุกคำสั่ง และแสดงผลสดใน Run panel
[commands.install]
executable = "bun"
args = ["install", "--frozen-lockfile"]
timeout_seconds = 600

[commands.build]
executable = "bun"
args = ["run", "build"]
timeout_seconds = 600

[commands.test]
executable = "bun"
args = ["run", "test"]
timeout_seconds = 600

[commands.dev]
executable = "bun"
args = ["run", "dev"]
long_running = true
start = "on_request"   # เปิดเมื่อเจ้าของหรือ AI ขอผ่าน harness.run

[checks]
final = ["build", "test"]   # คำสั่งที่ต้องผ่านก่อน ready_for_review
```

| หลักฐาน   | บันทึกอะไร                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Input     | task ID แบบ account-scoped, ticket snapshot hash, repo/base SHA, instruction/policy digests              |
| Execution | provider/version/session ID, run/attempt ID, start/end, exit/result status และ usage ที่ provider ส่งมา  |
| Changes   | worktree path, Git diff, untracked files และ tree digest ที่ไม่อาศัย agent summary                       |
| Checks    | command/args, environment profile, timestamps, exit code, stdout/stderr artifact และ checked tree digest |
| Decision  | ผู้ใช้อนุมัติอะไร ตอนไหน สำหรับ revision ไหน พร้อมเหตุผลเมื่อ override                                   |

Status และ summary จาก agent ถือเป็นรายงาน; verifier/เจ้าของเป็นผู้ตัดสินผลจริง ไม่ให้ agent ปิด gate, เปลี่ยนผล test หรือรับรองงานของตัวเองผ่าน MCP

## 9. Process, recovery และ performance

- Adapter ใช้ absolute executable path ที่ผ่าน Doctor; spawn ด้วย argument array และ cwd ที่ native ตรวจแล้ว ไม่ผ่าน `cmd /c`/shell ที่ประกอบจากข้อความ
- Run ID สร้างก่อน spawn; start ที่ใช้ idempotency key เดิมคืน run เดิม ไม่เริ่ม process เพิ่ม
- SQLite transaction ล็อก active task/worktree; provider เปลี่ยนหรือ Retry ต้องไม่ทับ process เดิม
- Event ทุกอันมี `runId`, `attempt`, `sequence`; เขียน journal ก่อนส่ง UI และ replay จาก cursor หลัง reconnect โดยไม่ apply ซ้ำ
- UI รับ token/log เป็น batch และ paginate history; อัปเดตเฉพาะ Run panel ไม่ render ตารางทั้งชุดทุก token
- Crash/restart แสดง `interrupted` จนตรวจ owner/process identity/session ได้; ห้ามเชื่อ PID เดิมอย่างเดียวหรือ resume อัตโนมัติ
- Resume ต้องตรวจ provider session, worktree, current diff และ policy ใหม่; อย่าใช้ `continue latest` ไปโดน ticket อื่น
- Adapter contract ผูก CLI version และ protocol schema; Codex ใช้ schema ที่ generate จาก binary รุ่นที่ทดสอบ และไม่เปิด experimental capability โดยคาดเดาว่ามี
- Cancel/failed run เก็บ worktree; cleanup เป็นการลบที่ผู้ใช้เลือก ไม่ลบงานที่ยังไม่ commit อัตโนมัติ
- ลบบัญชี Jira ที่มี run ต้องหยุด run ก่อน และแสดง journal/context artifacts ที่จะลบตาม account; worktree ที่มีโค้ดยังไม่ commit ต้องแสดงแยกและไม่ลบทิ้งโดยอัตโนมัติ
- เปลี่ยน AI progress ใช้ store เดิม; run events เป็นหลักฐาน execution, ไม่ทำให้ task dirty และไม่สร้าง worklog จาก wall-clock โดยอัตโนมัติ

## 10. MCP เพิ่มอย่างไรให้ได้ประโยชน์

รุ่นแรกของ MCP ต้องเปิดแอปอยู่ และใช้ core/policy เดียวกับปุ่มใน UI; ไม่ทำ MCP อีกชุดที่เขียน SQLite/Dexie โดยข้าม rules ของแอป

MCP มีสองส่วน: **run tools** (`harness.run`, `harness.get_log`, `harness.git` ตามหัวข้อ 7.1) ที่แอปส่งให้ AI ของ run นั้นผ่าน `--mcp-config` ทำใน Phase 2 พร้อม Claude vertical slice; ส่วน **board tools** ด้านล่างทำใน Phase 5 Run tools ผูกกับ run ID/worktree ของ process นั้นเท่านั้น

| Tool ที่เสนอ          | สิทธิ์/ผล                                                                     |
| --------------------- | ----------------------------------------------------------------------------- |
| `tasks.list_ready`    | อ่านเฉพาะงานที่เจ้าของเตรียมไว้; ไม่เห็น secret หรือ local note ที่ไม่ opt-in |
| `tasks.get_context`   | คืน approved snapshot และ revision ของ task ที่อยู่ใน scope                   |
| `runs.request`        | ส่งคำขอรันเข้าสู่แอป; ไม่อนุญาตให้ agent มอบสิทธิ์เริ่มงานให้ตัวเอง           |
| `runs.get`            | อ่าน state/progress/evidence ของ run ที่ credential นั้นเข้าถึงได้            |
| `runs.report`         | แนบ checkpoint/report แบบ idempotent; ไม่ตั้ง checks passed/Done              |
| `runs.request_review` | ขอให้ harness ตรวจและส่งงานให้เจ้าของ review                                  |

Start grant ออกโดยเจ้าของผ่าน UI ผูก task/repo/provider/policy/expiry; native core ตรวจ grant และ active lease ก่อนเริ่ม process คำขอพร้อมกันได้เพียง run เดียว

หากเพิ่ม Backlog ให้เป็น eligibility ที่แยกชัด: agent อ่านโจทย์ได้ตาม scope แต่ไม่มี start grant สำหรับ Backlog; ย้ายไป To Do ไม่เริ่มเสียเงินเอง ยังต้องกด Run/ยืนยัน queue

Transport เริ่มด้วย local stdio bridge ไปยัง app broker ที่จำกัดผู้ใช้เครื่องเดียวกัน; ต้องมี handshake และ scoped capability token ถ้าแอปปิดให้คืน unavailable โดยไม่แอบ launch งาน หากภายหลังใช้ HTTP ต้อง bind loopback, ตรวจ Origin/Host และทำ auth ตาม [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

การเขียน board/note ที่ต้องผ่าน Dexie ให้ใช้ request → store action → persist → acknowledge พร้อม revision/idempotency; ไม่ให้ MCP process อ่าน IndexedDB โดยตรง และไม่อ้างว่าทำงานได้แบบ headless จนกว่าจะย้าย authority ของ board อย่างเป็นขั้นตอน

## 11. แยกสิ่งที่อยากได้จาก Kanzo เป็นลำดับ

| ความสามารถ                    | แผนสำหรับโปรเจกต์นี้                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Execute Claude/Codex ผ่าน app | ทำก่อน ด้วย Run Manager และ provider adapters                                                         |
| Personal harness              | ทำพร้อม runner: worktree, approvals, budget, checks และ recovery                                      |
| Shared board ผ่าน MCP         | ต่อจาก runner; เริ่มแบบแอปต้องเปิดและมี scoped grants                                                 |
| Agent-safe backlog            | ต่อพร้อม MCP; ไม่มี auto-claim/auto-start จาก Backlog                                                 |
| Local data folder             | เริ่มเฉพาะ harness config/journal/artifacts; Jira cache ยัง Dexie                                     |
| Markdown/JSON export          | ต่อเป็น snapshot export มี schema version และตัวเลือกข้อมูลส่วนตัว                                    |
| Git-based sync                | ทำหลัง export/import; ซิงค์ snapshot/config ที่คัดแล้ว ไม่ commit DB สด, credentials หรือ log ทั้งหมด |

การ sync ข้ามเครื่องต้องเลือกเครื่องทำงานหลักและหยุด run ก่อน handoff; Git merge ไม่ใช่ distributed lock และไม่ป้องกันสองเครื่องรัน task เดียวกัน การ import ticket reference ต้อง map Jira instance/account ให้ถูก ไม่จับคู่ด้วย issue key อย่างเดียว

## 11.5 Harness ของ agent: ส่วนประกอบที่ต้องมีจริง

"Agent harness" คือทุกอย่างรอบโมเดลที่ไม่ใช่ตัวโมเดล: agent loop, tools, การประกอบ context, state, การรันคำสั่ง, guardrails, feedback loops และ observability ([O'Reilly](https://www.oreilly.com/radar/agent-harness-engineering/), [OpenAI — Harness engineering](https://openai.com/index/harness-engineering/)) Claude Code เป็น harness ชั้นใน (loop, tools, context) แอปนี้เป็น harness ชั้นนอกที่ให้ environment, constraints, feedback และหลักฐาน ชื่อ tool อย่าง `harness.run` เป็นแค่ส่วน tools ไม่ได้ทำให้ระบบเป็น harness เอง

| ส่วน                    | ทำอย่างไรในแอปนี้                                                                                                                                                                                             | ระยะ       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Agent loop              | ใช้ของ Claude Code; ไม่สร้าง loop เอง                                                                                                                                                                         | —          |
| Tools                   | MCP ในแอป: `skill_list`, `skill_get`, `run`, `git`, `get_log`, `submit_plan` + permission handler `approve`                                                                                                   | 2          |
| Guardrails              | ไม่มี shell (`--restricted --tools`), handler ของแอป, worktree, budget เวลาที่ AI ทำงาน, Stop ทั้ง tree, ไม่ส่ง token ของเจ้าของ                                                                              | 1 ✓ / 2    |
| ประกอบ context          | `.harness/task.md` = snapshot ของ ticket (เนื้อหาเดียวกับ Copy for AI, note เป็น opt-in) + digest ใน run record; skill ชี้ไป `AGENTS.md`/`CLAUDE.md` ของ repo ปลายทาง                                         | 2          |
| State ข้าม session      | `.harness/progress.md` ที่ agent อัปเดตเองทุกครั้งที่จบช่วงงาน; session ใหม่ (retry/continue) อ่านไฟล์นี้ก่อน ไม่พึ่ง context เดิม ([Anthropic](https://anthropic.com/engineering/managed-agents))            | 2          |
| วางแผนก่อนลงมือ         | รอบวางแผนให้ tools อ่านอย่างเดียว + `submit_plan`; เจ้าของอนุมัติแล้วค่อย `--resume` พร้อม Edit/Write (plan mode ของ CLI ใช้ headless ไม่ได้: เขียนแผนลง `~/.claude/plans` และ `ExitPlanMode` ส่ง input ว่าง) | 2          |
| Feedback loops          | agent ขอ `run test/build/lint/hurl` ระหว่างทำ; `get_log` อ่าน log ของ dev server ที่แอปเปิด; ตรวจ UI ผ่าน browser เป็นระยะถัดไป                                                                               | 2 / 4      |
| ตรวจผลโดยไม่เชื่อ agent | แอปรัน checks สุดท้ายเอง (install ใหม่ถ้า manifest เปลี่ยน) แล้วค่อยเป็น `ready_for_review`; fail → รอบแก้ไม่เกิน 2                                                                                           | 2          |
| Evaluator แยก           | reviewer agent แบบอ่านอย่างเดียว ตรวจ diff เทียบ task + ผล checks ก่อนถึงเจ้าของ (agent มักให้คะแนนงานตัวเองสูงเกินจริง)                                                                                      | 2 ช่วงท้าย |
| บังคับกฎแบบกลไก         | lint/structural test ของ repo อยู่ใน checks ที่ต้องผ่าน                                                                                                                                                       | 2          |
| Observability           | journal + timeline ของทุกคำสั่ง, cost/turns จาก `result` ของ Claude                                                                                                                                           | 1 ✓ / 2    |
| วัดผล harness เอง       | ต่อยอด `scripts/harness-spike` เป็นชุด task fixture รันซ้ำทุกครั้งที่แก้ harness/skill                                                                                                                        | 4          |

## 12. ลำดับ implementation ที่เล็กแต่ใช้ได้ครบ

| ระยะ                           | ไฟล์/ขอบเขตที่คาดว่าจะเปลี่ยน                                                                                                                                                                                                                                                            | เกณฑ์จบ                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0 — Compatibility spike        | fake-provider fixture และ native integration harness                                                                                                                                                                                                                                     | พิสูจน์ start/stream/stop/session และ permission behavior ของแต่ละ provider บน target OS; รวมกรณี CLI เสีย                     |
| 1 — Local execution foundation | `src-tauri/src/harness/`, typed client ใน `src/lib/`, actions ใน store เดิม                                                                                                                                                                                                              | Doctor, repo binding, worktree, run journal และ Stop ใช้ได้กับ fake provider; ไม่เพิ่ม generic shell capability                |
| 2 — Claude vertical slice      | (2.1) MCP ในแอป + permission handler; (2.2) Claude adapter: plan → approve → implement → app checks → review พร้อม task.md/progress.md และ budget; (2.3) Run panel + AI Board projection; (2.4) Docker services + migration; (2.5) Accept → commit, push, Draft PR; (2.6) reviewer agent | กด Plan → approve → run → AI ขอ test ผ่านแอป → checks → review ได้; ทุกคำสั่งเห็นสดใน Run panel; เปิดแอปใหม่แล้วย้อนดู run ได้ |
| 3 — Codex adapter              | Codex app-server adapter; Claude SDK sidecar เฉพาะ capability ที่จำเป็น                                                                                                                                                                                                                  | flow เดียวกันผ่าน contract เดิม; แสดงข้อจำกัดการ approval/auth ตรงตาม adapter จริง                                             |
| 4 — Harden personal MVP        | native tests, existing E2E shims, docs และ packaging                                                                                                                                                                                                                                     | failure/cancel/restart ไม่ทำงานหาย; ทำงานบน Windows/Linux/macOS ตาม capability matrix                                          |
| 5 — MCP และ board tools        | app broker + thin MCP transport + eligibility/export                                                                                                                                                                                                                                     | external client เห็นข้อมูลเดียวกับ UI และข้าม grants/gates ไม่ได้                                                              |
| 6 — Portability                | versioned export/import, ต่อด้วย Git snapshot sync                                                                                                                                                                                                                                       | round-trip ข้อมูลที่เลือกได้; ไม่มี credentials และมี conflict handling                                                        |

ระยะ 1–4 คือรุ่นใช้ส่วนตัวที่เสนอ; MCP board tools และ Git sync ไม่ใช่ prerequisite ของปุ่ม Run ไม่มีทีมกลาง/daemon/auto-deploy ในชุดนี้

### ความคืบหน้า Phase 2

| ส่วน                                       | สถานะ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 MCP ในแอป + tools + permission handler | เสร็จ: Claude CLI จริงเชื่อมผ่าน HTTP ได้ (test `#[ignore]`); tools แยกตาม phase: planning = อ่าน + `submit_plan`, implementing = + `run`                                                                                                                                                                                                                                                                                                                                                   |
| 2.2 Claude adapter + pipeline              | เสร็จ: `.harness/task.md` (ไม่เข้า git), plan read-only → owner → `--resume` session เดิม → แอปรัน checks เอง (install ใหม่ถ้า manifest เปลี่ยน) → repair ≤ 2 → `ready_for_review`; budget 30 นาทีต่อ step ที่อนุมัติ ไม่นับเวลาที่แอป execute; Continue หลัง fail/stop/restart ใน session เดิมได้                                                                                                                                                                                          |
| ผลกับ Claude จริง (haiku, 2026-11-03)      | fixture `sum` ที่ test fail: วางแผนโดยไม่แก้ไฟล์ → อนุมัติ → แก้ `src/sum.ts`, เขียน progress, ขอ `run test` → แอปตรวจ `verify:test` ผ่าน → review; 25 วินาที, ~$0.009, ไม่มีการเรียก Bash                                                                                                                                                                                                                                                                                                  |
| 2.3 Run panel + AI Board                   | เสร็จ: Plan with Claude (note เป็น opt-in), อนุมัติ/แก้แผน, review แสดง checks ของแอป/ไฟล์ที่เปลี่ยน/progress, Accept/Request changes, Continue; สถานะ run ย้ายการ์ดไป Doing/Review/Done (ไม่แตะ Jira)                                                                                                                                                                                                                                                                                      |
| 2.4 Docker services + migration            | เสร็จ: Setup เสนอ services จาก compose (ไม่รองรับ `build:` และตัด `${VAR}` จาก shell ทิ้ง) + env overrides จาก `.env.example` เท่านั้น + คำสั่ง migrate จาก scripts; ตอน implement/verify แอปเรียก Docker Engine API (endpoint จาก Docker context, รับเฉพาะเครื่องนี้) สร้าง container label `jirasync.run` พอร์ตสุ่ม 127.0.0.1 รอ healthcheck → เขียนค่าใน `.env` ของ worktree → migrate (ล้ม = ไม่เริ่ม agent) → ลบ container ทุกครั้งที่จบ step; ทดสอบกับ Docker จริง (redis) แล้ว       |
| 2.5 Accept → commit, push, Draft PR        | เสร็จ: diff เปลี่ยนหลัง checks → รัน checks ใหม่; agent ร่างแบบอ่านอย่างเดียวผ่าน `submit_pr_draft` (แอปบังคับ title/commit อังกฤษแบบ conventional, body ไทย, ห้าม AI attribution); แอปเติม `## การทดสอบ` จาก checks ของตัวเองและลิงก์ Jira; commit ไม่รวม env ที่ copy มา; push; ถ้ามี PR เปิดอยู่แก้ตัวเดิม, ถ้า merged แล้วไม่ใช้ซ้ำ; ล้มขั้นไหนยังเป็น Review พร้อมเหตุผลและกด Accept ซ้ำได้; Check CI / Ready for review เปิดได้เมื่อ CI ผ่านทุกตัว (native ตรวจซ้ำก่อน `gh pr ready`) |
| 2.6 Reviewer agent                         | เสร็จ: หลัง checks ผ่าน reviewer agent อ่านอย่างเดียวใน session ใหม่ (ไม่ resume session ของคนเขียน) เทียบ task.md + diff + ผล checks แล้วส่ง `submit_review` (approve / concerns + findings); แจ้งเจ้าของเท่านั้น ไม่ตัดสินแทน; ถ้า reviewer ตอบไม่ได้ขึ้นว่า Not reviewed และยังไป review ได้; ปุ่ม Use findings as feedback                                                                                                                                                              |

### ความคืบหน้า Phase 1

| ส่วน                                                                                                                                                                    | สถานะ                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doctor (`git`, `claude`, `gh` + `gh auth status`, `hurl`, Docker context/endpoint/engine)                                                                               | เสร็จ: รัน process จริงพร้อม timeout ไม่ใช่แค่หาไฟล์; ผลแสดงในหน้า Setup และเปิดอัตโนมัติครั้งแรกถ้าไม่พร้อม                                                                                                                                                |
| ตรวจ repo (bun/npm/pnpm/yarn, Cargo, Go, uv; env files, key ที่ขาดจาก `.env.example`, service keys, compose files)                                                      | เสร็จ: deterministic ไม่ใช้ token; ส่งแค่ชื่อ key ไม่ส่งค่า                                                                                                                                                                                                 |
| Repo binding ต่อ project (validate git root, branch, worktree folder นอก repo, env path ใน repo)                                                                        | เสร็จ: `harness/bindings.json` ใน app data, Setup → Repositories                                                                                                                                                                                            |
| Worktree จาก `origin/<base>` ล่าสุด + copy env + ลบแบบไม่ทิ้งงานที่ยังไม่ commit                                                                                        | เสร็จ: ใช้ผ่าน run (Prepare workspace) และปุ่ม Remove worktree ที่ต้องยืนยันก่อนทิ้งงาน                                                                                                                                                                     |
| Run manager: 1 active run, journal `runs/<id>/run.json` + `events.ndjson`, output สดทีละบรรทัด, replay ต่อจาก `seq`, Stop ฆ่าทั้ง process tree, restart → `interrupted` | เสร็จ: Rust tests ใช้ process จริง (มี grandchild) แทน fake provider; ขั้น agent ใน core มีแล้ว แต่ UI เปิดเฉพาะ Prepare workspace (worktree → env → install) จนกว่าจะต่อ Claude ใน Phase 2                                                                 |
| Run panel ใน task detail ของ AI Board                                                                                                                                   | เสร็จ: สถานะ, log, Stop, Prepare again, Open folder, Remove worktree; บอกเหตุผลเมื่อมี run อื่นทำอยู่                                                                                                                                                       |
| process ที่ step ทิ้งไว้                                                                                                                                                | แก้แล้ว (2026-11-03): ทุก step อยู่ใน Windows Job Object (`KILL_ON_JOB_CLOSE`) / process group บน macOS-Linux; ถ้า step จบแต่ยังมี process ถือ output อยู่ แอปรอ 5 วินาทีแล้วปิดทั้งกลุ่ม และบอกใน log (ทดสอบบน Windows แล้ว; macOS/Linux ยังไม่ได้รันจริง) |

ทดสอบ: Rust 26 tests (git และ process tree จริงใน temp dir), e2e 12 tests ใหม่ (positive + negative), mutation 8 จุดที่ทำให้ test fail จริง (รวม Stop ที่ฆ่าแค่ parent)

### ผล Phase 0 (2026-11-03, Windows, Claude Code 2.1.317, model `haiku`)

รัน `bun scripts/harness-spike/spike.ts <empty-dir>` ([spike.ts](../scripts/harness-spike/spike.ts) + MCP server จำลอง Rust core [mcp-harness.ts](../scripts/harness-spike/mcp-harness.ts)) กับ fixture repo ที่มี test fail และ endpoint ที่ยังไม่ทำ: ผ่าน 21/21 checks, ราว $0.005 และ ~15 วินาทีต่อ task

| ผล               | รายละเอียด                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ไม่มี shell จริง | tools = `Edit, Glob, Grep, Read, Skill, Write` + `mcp__harness__*`; รอบแรกที่ harness tool ถูกปฏิเสธ AI พยายามเรียก `Bash` แล้วได้ "No such tool" และรายงานตรงว่ายังไม่ได้ verify                   |
| Approval         | `--allowedTools` และ `--settings` ไม่มีผลกับ MCP tools ภายใต้ `--restricted`; `--permission-prompt-tool` ใช้ได้                                                                                     |
| Skill            | โหลดผ่าน `--plugin-dir` ได้ใต้ `--restricted` แต่ต้องมี tool `Skill`; เมื่อโหลดแล้ว AI วางไฟล์ที่ `.harness/http/*.hurl` และใช้ `{{base_url}}` ตาม skill                                            |
| Execute ผ่านแอป  | AI ขอ `test` → `dev` → `hurl` ผ่าน `harness.run`; แอปบันทึกทุกคำสั่งพร้อมเวลา ทำให้แยกเวลาที่ AI ทำงานออกจากเวลา execute ได้                                                                        |
| ผลตรวจจริง       | แอปรัน `bun test` ซ้ำเองหลัง AI จบ: ผ่าน; AI ไม่ commit; base repo ไม่เปลี่ยน                                                                                                                       |
| Session          | `--session-id` ที่แอปกำหนดถูกใช้จริง และ `--resume <id>` ตอบต่อจาก context เดิมได้                                                                                                                  |
| Stop             | `taskkill /T /F` ปิด claude, MCP server และ dev server ที่ MCP เปิดไว้ได้ครบ                                                                                                                        |
| Negative         | เขียนนอก worktree ถูก `--restricted` บล็อกเอง; เขียน `.claude/settings.json` ถูก handler ของแอปปฏิเสธ; mutation ให้ handler อนุญาตทุกอย่างทำให้ check นี้ fail จริง                                 |
| ข้อสังเกต        | skill ส่วนตัวใน `~/.claude/skills` และ plugin ของผู้ใช้ไม่ถูกโหลดใต้ `--restricted` อยู่แล้ว ที่เห็นก่อนหน้าเป็น built-in skills ซึ่งตอนนี้ปิดแล้ว; ยังไม่ได้ทดสอบ macOS/Linux, Codex และ plan mode |

## 13. Acceptance และการทดสอบ

| Given / When                                                    | Then                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| CLI มีไฟล์แต่เริ่มไม่ได้ / เปิด Doctor                          | Run disabled พร้อม error ที่แก้ไขได้                              |
| ticket และ repo พร้อม / กด Plan                                 | มี context snapshot และ worktree ใหม่ โดย checkout เดิมไม่เปลี่ยน |
| ยังไม่ approve plan / agent ขอเขียนไฟล์                         | ไม่เริ่ม implement ตาม grant; ไม่ใช้ bypass แก้ปัญหา              |
| approve แล้ว / สั่ง Run ซ้ำหรือ MCP request ซ้ำ                 | ได้ run เดิมหรือ busy; ไม่มี process เขียนงานซ้อน                 |
| agent บอกเสร็จแต่ test fail / verifier จบ                       | ไม่เป็น completed และเก็บ output ของ failure                      |
| checks ผ่าน / diff หรือ policy เปลี่ยน                          | ผลตรวจ/approval เดิมหมดอายุ ต้องตรวจใหม่                          |
| run กำลังทำ / เปลี่ยน page หรือ WebView reconnect               | งานเดิมดำเนินต่อและ replay events ไม่ซ้ำ                          |
| process สร้าง subprocess / กด Stop                              | หยุด process tree ตามข้อรองรับของ OS โดยเก็บ diff                 |
| app crash / เปิดใหม่                                            | แสดง interrupted, ไม่กู้คืนด้วย PID หรือ resume ทันที             |
| AI completed / ตรวจ Jira requests                               | ไม่มี Jira transition/comment/worklog ที่ไม่ได้สั่ง               |
| Accept / push ล้ม                                               | ยังเป็น Review, retry ต่อจากขั้นที่ล้มได้ ไม่สร้าง commit/PR ซ้ำ  |
| Accept / branch มี PR เปิดอยู่แล้ว                              | edit PR เดิม ไม่สร้างใหม่                                         |
| PR body / มีคำสั่งที่ไม่ได้รันหรือ fail                         | `## การทดสอบ` เป็น `[ ]` ติ๊กเฉพาะที่แอปรันผ่านบน revision นั้น   |
| binding ต้องใช้ DB / Docker เชื่อมไม่ได้                        | หยุดก่อนเริ่ม AI ไม่ใช้ DB ของ base repo                          |
| repo ไม่มีคำสั่ง migrate / ผูก repo                             | ถามเจ้าของครั้งเดียวและจดไว้ run ต่อไปไม่ถามซ้ำ                   |
| compose มี service ที่ใช้ `build:` / ผูก repo                   | แสดงว่าไม่รองรับและให้เลือก image ไม่ข้ามเงียบ                    |
| Jira Done ระหว่าง run / sync สำเร็จ                             | ปิดงาน AI/ซ่อนตามเดิมและขอ Stop โดยเก็บ run history               |
| MCP อยู่ต่าง task/account หรือไม่มี grant / ขอเขียนหรือเริ่มงาน | ปฏิเสธ โดยไม่เปลี่ยน task/lease ที่ไม่เกี่ยวข้อง                  |

ใช้ unit สำหรับ policy/state normalization, fake subprocess สำหรับ protocol/cancel/recovery, existing Playwright สำหรับ user flow และ packaged native checks สำหรับ process tree/sandbox; browser shim อย่างเดียวพิสูจน์ native runner ไม่ได้

เพิ่ม SQLite journal แบบแยก domain; ถ้าต้องเปลี่ยน Dexie schema ให้ append `SCHEMA_VERSIONS` เท่านั้น rollback ใช้ forward fix และปิด runner โดยเก็บ journal/worktree ไม่ลบ DB

## 14. ข้อสรุปและเรื่องที่ยังต้องพิสูจน์

| เรื่อง             | สถานะ                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ขอบเขต             | ตกลงแล้ว: personal local harness ก่อน                                                                                                                                                                                                                                                                                                            |
| ทิศทาง             | เสนอ: execute ผ่าน app ก่อน, MCP เชื่อม core เดียวกันภายหลัง                                                                                                                                                                                                                                                                                     |
| Jira domain        | คงพฤติกรรมเดิม; agent ไม่มีสิทธิ์ปิด Jira ตาม AI Done                                                                                                                                                                                                                                                                                            |
| CLI readiness      | Claude `2.1.317` และ Codex `0.166.0` เรียกได้; ทำ Claude ก่อน                                                                                                                                                                                                                                                                                    |
| Workspace          | ตกลงแล้ว: install จริงใน worktree; services ดึงจาก compose ส่ง Docker API; migrate ตาม binding (หาไม่เจอถามเจ้าของ); Accept = commit+push+PR; copy `.env` + overrides จาก `.env.example`; services ผ่าน Docker API ต่อ run; แอป execute install/build/test/dev (AI ขอผ่าน MCP run tools, dev เปิดเมื่อขอ) และแสดงผลสด; ปุ่ม Setup ขวาบน AI Board |
| Claude auth        | ต้องเลือกให้ตรง CLI/SDK mode ใน spike; ไม่สมมติว่าเอา subscription token มาใช้ใน SDK ได้                                                                                                                                                                                                                                                         |
| Sandbox            | ต้องมีผลทดสอบแยก Windows/Linux/macOS; worktree/permissions ไม่ได้เท่ากับ OS isolation                                                                                                                                                                                                                                                            |
| First usable slice | Claude + repo binding + worktree bootstrap + plan/run/check/review; ตามด้วย Codex                                                                                                                                                                                                                                                                |
| สถานะเอกสารนี้     | Phase 0 ผ่านบน Windows (ดู "ผล Phase 0"); ยังไม่มี native commands ในแอป, Docker, Setup UI หรือ migration                                                                                                                                                                                                                                        |

## แหล่งอ้างอิง

- Repo: [app lifecycle](../src/App.tsx), [single store](../src/store/task-store.ts), [Dexie schema](../src/lib/jira-db.ts), [native entry](../src-tauri/src/lib.rs), [capabilities](../src-tauri/capabilities/default.json)
- [OpenAI Docs — Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Docs — non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code — programmatic usage](https://code.claude.com/docs/en/headless)
- [Claude Code — CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Agent SDK — permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK — TypeScript and packaging](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Code — authentication and product integration](https://code.claude.com/docs/en/legal-and-compliance)
- [MCP — transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
