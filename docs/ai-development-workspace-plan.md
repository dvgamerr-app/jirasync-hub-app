# แผน AI handoff สำหรับ dev ที่ทำงานร่วมกับ AI

วันที่: 2026-11-01 (แก้ไขหลัง review)  
สถานะ: พัฒนา MVP แล้ว; ยังไม่ release และยังไม่เริ่ม gate ทดลองใช้ 2 สัปดาห์

## เป้าหมาย

ลดงานซ้ำตอนต้นและตอนท้ายของการทำ ticket กับ AI โดยใช้ข้อมูลที่แอปมีอยู่แล้ว (ticket ที่ sync ไว้, note, worklog, comment) ไม่สร้างระบบติดตาม session ซ้อนกับ repo

ทดลองใช้ MVP เล็ก ๆ ก่อน แล้วใช้ข้อมูลการใช้งานจริงตัดสินว่าควรทำ workspace/session ต่อหรือไม่

## 1. Pain และสิ่งที่แอปนี้ช่วยได้จริง

| Pain                                         | แนวทาง                                                                                   | ทำในรุ่นแรก              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| ต้องประกอบ prompt จาก Jira ซ้ำ               | `Copy for AI` แปลง ticket (รวม ADF description) เป็น Markdown พร้อม copy                 | ใช่                      |
| กลับมาวันถัดไปแล้วลืมว่าถึงไหน               | ใช้ note เดิม (local-only) เป็น handoff พร้อม template และแนบเข้า context ได้            | ใช่                      |
| จบงานแล้วต้องเขียนสรุปกลับ Jira และ log เวลา | Dialog `Summarize to Jira` วางสรุปจาก AI แก้แล้วส่ง comment พร้อมกรอก worklog ในที่เดียว | ใช่                      |
| Ticket เขียนไม่ครบ แล้ว AI ตัดสินใจแทน       | Context มีหัวข้อ "คำถามที่ต้องถามก่อนลงมือ" ให้ AI ตอบก่อน implement                     | ใช่ (ข้อความใน template) |
| หลาย ticket หลาย session ตามไม่ทัน           | ใช้ branch/PR/handoff ใน repo; แอปไม่เก็บสถานะ session ที่ต้องกรอกเอง                    | ไม่                      |
| AI บอกว่าเสร็จแต่ไม่รู้ว่าตรวจอะไร           | หลักฐานจริงอยู่ที่ CI/PR; แอปไม่ทำ checkbox "ยืนยันแล้ว" ที่ไม่มีหลักฐานรองรับ           | ไม่                      |

เหตุผลที่ตัด session/checkpoint/review ออก:

- ข้อมูลพวกนี้มีที่อยู่จริงใน repo, commit, PR และ session ของเครื่องมือ AI อยู่แล้ว ถ้าให้คัดลอกมาลงแอปจะกลายเป็นแหล่งข้อมูลซ้ำที่ค้างเก่าเร็ว
- ในรุ่นแรกแอปยังไม่ผูกกับ Git ทำให้สถานะ session และผลตรวจกลายเป็นข้อมูลที่ผู้ใช้กรอกเอง ซึ่งตรวจสอบไม่ได้
- ยังไม่มีข้อมูลว่า dev ใช้ workflow นี้บ่อยแค่ไหน (แผนเดิมมาจากการอ่าน source ไม่ได้มาจากการใช้งานจริง)

## 2. ขอบเขต MVP

### 2.1 `Copy for AI`

ปุ่มใน `TaskDetailPanel` เปิด preview แล้ว Copy ได้ ใช้งานได้ขณะ offline เพราะอ่านจาก store

Markdown ที่ได้มีตามลำดับ:

1. Key, summary, type, status, severity, story points, Jira URL
2. Description ที่แปลงจาก ADF เป็น Markdown (รักษาตัวพิมพ์, code block, list และ link)
3. Parent/Epic (key + summary)
4. Note เดิม — **แนบเฉพาะเมื่อผู้ใช้ติ๊กเลือก** (ค่าเริ่มต้นปิด)
5. คำสั่งท้าย: "ถ้า ticket ไม่ชัด ให้ถามก่อนลงมือ" และรูปแบบสรุปที่อยากได้กลับ (ทำอะไรไป, ตรวจอะไร, เหลืออะไร)

ไม่มี credentials, account อื่น หรือ worklog ของคนอื่น ไม่เขียนไฟล์ใน repo และไม่มีการตั้งค่าต่อ project ในรุ่นแรก (repo hints ให้ dev ใส่ใน `CLAUDE.md`/`AGENTS.md` ของ repo ตามปกติ)

### 2.2 Handoff ใน note เดิม

- ปุ่ม `Insert handoff template` เติมหัวข้อ `Done / Next / Blocked` ต่อท้าย note เดิม (ไม่ทับข้อความที่มี)
- พฤติกรรมของ note เหมือนเดิมทั้งหมด: ไม่ทำให้ task dirty, ไม่ถูก pull ทับ, discard ไม่ลบ (`sync-service.ts`, `task-store.ts` จัดการไว้แล้ว)
- Note มีอายุเท่ากับ local task: full sync ยังลบ task ของ project ที่หายไปจาก Jira results ได้ หาก task ไม่ dirty และไม่มี pending worklog; note จะหายตาม task การลบบัญชีที่ผู้ใช้ยืนยันก็ลบ note ด้วย
- MVP คง lifecycle และ cleanup เดิม ระบุข้อจำกัดนี้ในคำอธิบาย handoff และคู่มือ โดยให้ handoff ที่ต้องเก็บระยะยาวอยู่ใน repo

### 2.3 `Summarize to Jira`

Dialog แยกจาก note เพื่อไม่ให้ handoff ส่วนตัวถูกโพสต์ไปด้วย:

- ช่องวางสรุปจาก AI → ผู้ใช้แก้ → กด `Post comment` ผ่าน `postNoteAsComment` เดิม (ส่งเป็น comment เท่านั้น ไม่ execute อะไรจากข้อความ)
- ช่องเวลาใช้ `parseTimeInput` และ preview เดียวกับ Log Work ผู้ใช้กรอกเวลาเองแล้วกด `Add worklog` เพื่อสร้าง pending worklog ตาม flow เดิม แอปไม่คำนวณจากระยะเวลา session
- ไม่เปลี่ยน Jira status อัตโนมัติ

#### ผลสำเร็จแยกกันและการลองใหม่

- `Post comment` และ `Add worklog` เป็นคนละปุ่ม มีสถานะกำลังทำงาน/สำเร็จ/ผิดพลาดแยกกัน ปิดปุ่มของ operation ที่กำลังทำเพื่อกันกดซ้ำ
- ส่วนที่สำเร็จแล้วคงผลไว้ และไม่ถูกทำซ้ำเมื่อลองอีกส่วนที่ผิดพลาด เช่น comment ส่งแล้ว แต่ worklog บันทึกไม่สำเร็จ ให้ลองเฉพาะ worklog
- หลังสำเร็จ ปุ่มของข้อมูลชุดนั้นใช้ซ้ำไม่ได้จนกว่าผู้ใช้เริ่มรายการใหม่อย่างชัดเจน การปิดแล้วเปิด dialog เดิมระหว่างเปิดแอปต้องคงผลสำเร็จไว้ด้วย
- ปรับ `addWorkLog` ให้คืน Promise ที่รายงานผลการบันทึก IndexedDB ได้ เพราะปัจจุบันเป็น background write ที่ caller รอผลไม่ได้ ต้องเก็บ pending worklog สำเร็จก่อนแสดงว่า “บันทึกแล้ว รอ push”
- อัปเดต `LogWorkModal` และ callers ที่ได้รับผลจาก action นี้ให้รอผลก่อนล้างฟอร์มหรือปิด และคงข้อมูลพร้อมแสดง error หากบันทึกไม่สำเร็จ โดยไม่เปลี่ยน flow push เดิม
- ถ้า comment ส่งไม่สำเร็จ ให้เก็บข้อความและแสดง error หาก timeout/การเชื่อมต่อขาดจนยืนยันไม่ได้ว่า Jira รับแล้วหรือยัง ให้แสดงว่าผลไม่แน่ชัดและให้ตรวจ Jira ก่อนส่งใหม่ ไม่ส่งซ้ำอัตโนมัติ
- สถานะ pending worklog หมายถึงเก็บในเครื่องแล้ว การส่งขึ้น Jira ยังใช้ปุ่ม push เดิม

#### Draft และ ticket เป้าหมาย

- เก็บ draft และผลของแต่ละ operation ใน Zustand store เดิม แยกตาม account-scoped task ID ตรึง `taskId` และ `accountId` ตั้งแต่เปิด draft พร้อมแสดง ticket key เป้าหมายใน dialog
- การเลือก ticket B ระหว่างที่มี draft ของ A ต้องไม่ย้าย draft หรือเป้าหมายส่งของ A ไป B การส่งที่กำลังทำใช้ target และ payload ณ ตอนกด ไม่อ่านจาก selection ที่เปลี่ยนภายหลัง
- ปิด dialog แล้วกลับมาเปิด ticket เดิม ให้คืน draft และผลสำเร็จเดิมระหว่างที่แอปยังเปิดอยู่ การล้าง draft ที่ยังไม่ส่งต้องเป็นการทิ้งโดยผู้ใช้ ไม่เกิดจากการเปลี่ยน selection
- ก่อนแต่ละ operation ตรวจว่า task และ account เป้าหมายยังมีอยู่ หากถูกลบให้แสดง error โดยไม่ส่งหรือสร้าง worklog ผิดรายการ
- Draft อยู่ในหน่วยความจำระหว่างเปิดแอป รุ่นแรกไม่เก็บข้าม reload/restart และไม่บันทึก summary ส่วนนี้ลง note ส่วนตัวอัตโนมัติ

## 3. ข้อมูลและ schema

ส่วน context/handoff ใช้ `Task.note` และ worklog เดิม ส่วน AI Board เพิ่ม schema v3 แบบ append-only สำหรับ `aiBoardStates: "id, accountId, status"` เพื่อเก็บความคืบหน้า AI แยกจาก Jira ตามข้อ 11 โดยไม่เปลี่ยน task/worklog เดิม

เพิ่มเฉพาะ UI draft และสถานะ operation ใน Zustand store เดิม ไม่ทำให้ task dirty การเพิ่ม worklog ยังคงทำให้ task dirty ตาม flow เดิม แต่ action ต้องรายงานผลการ persist ให้ caller ทราบ

Logic ใหม่เป็น pure function:

- `adfToMarkdown()` ใน `src/lib/adf-content.ts` — แยกจาก `getDescriptionSearchText()` ที่ใช้กับ search (ห้ามเปลี่ยนพฤติกรรม search)
- `buildAiContext(task, { parent, includeNote })` ใน `src/lib/ai-context.ts`

## 4. ลำดับ implementation

| ลำดับ | ไฟล์                                                                                                           | จุดตรวจรับ                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1     | `src/lib/adf-content.ts`, `src/lib/ai-context.ts`                                                              | ADF → Markdown รักษาข้อความ/code/link; search เดิมไม่เปลี่ยน                                  |
| 2     | `TaskDetailPanel.tsx` + dialog `Copy for AI`                                                                   | Preview ตรงกับที่ copy; note แนบเฉพาะเมื่อเลือก; ใช้ได้ offline                               |
| 3     | `TaskDetailPanel.tsx` (note) — `Insert handoff template`                                                       | ต่อท้าย note เดิม ไม่ทำให้ dirty และระบุ lifecycle ของ note                                   |
| 4     | Dialog `Summarize to Jira` + `src/store/task-store.ts`                                                         | แยกปุ่มและผล comment/worklog; draft ตรึง account/task และกลับมาเปิดต่อได้ระหว่างเปิดแอป       |
| 5     | `addWorkLog`, `LogWorkModal.tsx`, callers ใน `TaskDetailPanel.tsx`/`TaskTable.tsx` และ tests เดิมที่เกี่ยวข้อง | รอผล IndexedDB ก่อนแจ้งสำเร็จ/ล้างฟอร์ม; error เก็บข้อมูลไว้; retry ไม่ทำส่วนที่สำเร็จแล้วซ้ำ |
| 6     | Tests + `docs/user-guide.th.md`                                                                                | Positive/negative ครบตามข้อ 5 และคู่มือระบุ lifecycle ของ note/draft กับสถานะ pending worklog |

ไม่เพิ่ม dependency และไม่อัปเกรด packages ในงานนี้

## 5. เกณฑ์ตรวจรับ

| Positive                                                              | Negative                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Context มี key, description (Markdown), parent ครบ                    | ไม่มี note ถ้าไม่ได้เลือก, ไม่มี credentials/ข้อมูลข้าม account                                                   |
| ADF code/link/ตัวพิมพ์ถูกรักษา                                        | Search ใน description ทำงานเหมือนเดิม                                                                             |
| Handoff template ต่อท้าย note เดิม                                    | Insert template ไม่ทำให้ task dirty และไม่เรียก Jira                                                              |
| Summarize โพสต์ comment ได้และสร้าง worklog ตามเวลาที่กรอก            | ไม่มีการโพสต์/log เวลาจนกว่าผู้ใช้กด; post fail แล้วข้อความไม่หาย                                                 |
| Comment สำเร็จและ worklog ผิดพลาด แสดงผลแยกกันและลองเฉพาะ worklog ได้ | ไม่โพสต์ comment ซ้ำเมื่อลอง worklog ใหม่ และไม่เกิดรายการซ้ำจากการกดระหว่างกำลังทำ                               |
| Worklog บันทึก IndexedDB สำเร็จจึงแจ้งว่าเก็บแล้วและรอ push           | DB write ล้มเหลวแล้วไม่แจ้งสำเร็จ ไม่ล้างข้อมูลฟอร์ม และไม่แสดงว่า push แล้ว                                      |
| ปิด/เปิด dialog ของ A ได้ draft และผลเดิม; เปิด B ได้ข้อมูลของ B      | เปลี่ยน ticket ระหว่างกรอก/ส่งแล้วไม่ส่ง draft ของ A ไป B หรือข้าม account                                        |
| Target ที่ยังอยู่ส่งตาม payload ณ ตอนกดได้                            | Task/account ที่ถูกลบทำให้ operation แจ้ง error โดยไม่มี side effect; comment ที่ผลไม่แน่ชัดไม่ถูกส่งซ้ำอัตโนมัติ |
| Copy for AI ใช้ได้ขณะ offline                                         | การเปิด/copy context ไม่ทำให้มี request ไป Jira                                                                   |

- Pure logic: unit tests ใน `bun test` (`adf-content`, `ai-context`)
- E2E หนึ่งไฟล์ `e2e/ai-handoff.e2e.ts` ใช้ fake Jira และ shims เดิม
- ก่อนส่ง: `bun run lint`, `bun run build`, `bun run test`, `bun run test:e2e`, `bun x tsc --noEmit -p e2e/tsconfig.json`

ใช้ fake Jira จำลอง partial success และ delayed response เพื่อทดสอบเปลี่ยน ticket ระหว่างส่ง ใช้ shims/mocks จำลอง IndexedDB write failure โดยไม่เรียก network จริง ไม่เพิ่ม tests ที่ซ้ำกับ coverage เดิมของ note/pull/discard และคง cleanup เดิมตามข้อจำกัดที่ระบุไว้

## 6. Gate ก่อนทำต่อ

ทดลองใช้เองอย่างน้อย 2 สัปดาห์หลัง release แล้วตอบคำถามเหล่านี้ก่อนเริ่มระยะถัดไป:

- `Copy for AI` ใช้จริงกี่ ticket หรือยังเปิด Jira/ใช้ Jira MCP แทน
- Handoff ใน note ถูกเขียนต่อเนื่องไหม หรือเขียนไว้ใน repo แทน
- `Summarize to Jira` ลดเวลาเขียนสรุป/log เวลาได้จริงไหม
- ปัญหาที่ยังเหลือคืออะไร (เช่น ต้องการ project context, ต้องการเห็นหลาย ticket ที่ค้างอยู่)

จดผลด้วยมือระหว่างทดลอง โดยยังไม่เพิ่ม analytics หรือ telemetry:

| สิ่งที่จด                                   | ข้อมูลที่ใช้ตัดสิน                                                   |
| ------------------------------------------- | -------------------------------------------------------------------- |
| จำนวน ticket ที่ทดลองและใช้แต่ละฟีเจอร์จริง | จำนวนโอกาสใช้งานเทียบกับจำนวนที่เลือกใช้ ไม่ดูแค่ระยะเวลา 2 สัปดาห์  |
| งานที่ยังต้องประกอบ context/คัดลอกซ้ำ       | ติดที่ข้อมูลไม่ครบหรือขั้นตอนส่งต่อ และมีตัวอย่าง ticket ใด          |
| ที่อยู่ของ handoff ที่ใช้กลับมาทำต่อจริง    | Note ในแอปหรือ repo และต้องเขียนซ้ำกี่ครั้ง                          |
| เวลาที่ใช้สรุปและ log งาน                   | ตัวอย่างก่อน/หลังใช้ dialog พร้อมปัญหาที่พบ เช่น retry หรือข้อมูลหาย |

ถ้ายังมีจำนวน ticket ที่ทดลองน้อย ให้ระบุว่าข้อมูลยังไม่พอสำหรับขยาย scope และทดลองต่อก่อนตัดสินระยะถัดไป

## 7. ระยะต่อยอด (ทำต่อเมื่อ gate ข้อ 6 ยืนยันว่าจำเป็น)

| ระยะ                   | สิ่งที่จะเพิ่ม                                                                           | เงื่อนไข/ข้อควรระวัง                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2: AI อ่าน context เอง | Local bridge/MCP ให้ AI อ่าน context และส่ง draft handoff/summary กลับ (ไม่ส่ง Jira เอง) | IndexedDB อยู่ใน WebView จึงต้องผ่านแอปไปยัง store เดิม; แยกสิทธิ์อ่านกับเขียน draft และตรวจตัวตน client ตาม [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) |
| 3: Repo/Git            | ผูก ticket กับ repo/branch, อ่าน diff/commit เป็นหลักฐาน                                 | เพิ่มสิทธิ์อ่านเฉพาะ repo ที่ผู้ใช้เลือก ตาม [Tauri File System](https://v2.tauri.app/plugin/file-system/); ต้อง `bun run cg:check` และตรวจบน Tauri จริง                                                                         |
| 4: Workspace/session   | ตาราง `devWorkspaces`/`devSessions`, project context, รายการ Development ใน sidebar      | ทำเมื่อมีข้อมูลว่า note อย่างเดียวไม่พอ; schema ใหม่เพิ่มเป็น entry ถัดไปใน `SCHEMA_VERSIONS` เท่านั้น และ cleanup ตอนลบบัญชีต้องครอบคลุมข้อมูลใหม่                                                                              |

Bridge (ระยะ 2) มาก่อน Git และ workspace เพราะเป็นส่วนที่ตัด copy/paste ซึ่งเป็นแรงเสียดทานหลักได้จริง ส่วน Git และ workspace เพิ่มข้อมูลที่ต้องดูแลมากขึ้น

ไม่อยู่ในทุกระยะของแผนนี้: รัน agent, สร้าง branch/worktree อัตโนมัติ, สั่ง shell, เปลี่ยน Jira status หรือ log เวลาอัตโนมัติ

## 8. Source ที่ใช้ออกแบบ

- [Task model](../src/types/jira.ts) — `note` เป็น local-only
- [Task store](../src/store/task-store.ts) — `updateTaskNote`, `postNoteAsComment`, การคง note ตอน push/discard
- [Pull sync](../src/lib/sync-service.ts) — การคง note ตอน pull
- [ADF และ description search](../src/lib/adf-content.ts)
- [Task detail](../src/components/TaskDetailPanel.tsx) — `NoteFieldEditor` และปุ่ม "Post as Jira comment"
- [E2E fixtures และ tests](../e2e/)

## 9. ผล implementation และการตรวจสอบ

- เพิ่ม `CopyForAiDialog`, `SummarizeToJiraDialog` และ handoff template ใน note ตามขอบเขต MVP
- Context ใช้ `src/lib/ai-context.ts` และ `adfToMarkdown()`; draft และ operation state อยู่ใน store เดิม แยกตาม account-scoped task ID ส่วนสถานะ AI เก็บแยกตามข้อ 11
- Worklog บันทึกพร้อม dirty task ใน IndexedDB transaction และรอผลก่อนแจ้งสำเร็จ ส่วน comment/worklog แยกผลและป้องกันการลองส่วนที่สำเร็จแล้วซ้ำ
- `bun run test`: 199 tests ผ่าน; `bun run test:e2e`: 87 tests ผ่านก่อนเพิ่มเคส Log Work และ `e2e/ai-handoff.e2e.ts` รุ่นล่าสุดผ่านทั้ง 5 เคส รวมเคสที่เพิ่ม
- `bun run lint`, `bun run build` และ e2e type-check ผ่าน พร้อม throwaway check ด้วย `node:assert/strict`
- Mutation check: เมื่อลองแนบ note โดยไม่ตรวจ opt-in, test ต้องล้มเหลว จากนั้นคืน guard และตรวจว่า test ผ่านแล้ว
- เพิ่ม unit test file สำหรับ pure context builder และ E2E file สำหรับ user flow ใหม่ ส่วน ADF/store/UI mocks ขยายไฟล์ tests เดิม
- ปรับ TypeScript จาก 7.0.2 กลับเป็น 6.0.3 เพราะ typescript-eslint ที่ติดตั้งยังไม่รองรับ TS 7 และเติม exports ที่ขาดใน mocks เดิมสองจุด
- คู่มืออยู่ใน [user-guide.th.md](user-guide.th.md) หัวข้อ “ทำงานร่วมกับ AI”

การตรวจ UI ใช้ browser และ fake Jira; ยังไม่ได้ตรวจแพ็กเกจ Tauri จริงหรือ Jira จริง Gate ข้อ 6 จะเริ่มหลัง release และเป็นเงื่อนไขก่อนทำระยะถัดไป

## 10. ขอบเขตหน้าใหม่ตาม Kanzo

ผู้ใช้ยืนยันให้เก็บ layout หน้าเดิมไว้ และเพิ่มอีกหนึ่ง page โดยอ้างอิง `E:\kanzo` หน้าเดิมยังเป็น route `/`; หน้าใหม่เป็น `/ai-board` มีเมนูเข้าใช้งานและลิงก์กลับแยกกัน

- ใช้รูปแบบ sidebar โปรเจกต์, คอลัมน์สถานะ, การ์ดลากย้าย และ detail panel ด้านขวาตาม reference ใน `E:\kanzo\src\index.html`, `src\app.js` และ `docs\img\task-dark.jpg` โดยเขียน UI สำหรับ React ของ repo นี้
- แสดง Jira tasks จาก IndexedDB/store เดิม ใช้คอลัมน์ AI คงที่ `To Do / Doing / Review / Done`; มี project filter, search และจำนวนงาน ส่วน selection/filter ของ board แยกจากหน้าเดิมใน store เดียว
- การย้ายการ์ดเปลี่ยนเฉพาะสถานะ AI ไม่แตะ Jira fields/dirty state และไม่เรียก transitions ตามขอบเขตล่าสุดในข้อ 11
- Detail panel ใช้ description, local handoff, Copy for AI และ Summarize to Jira ที่ทำไว้ ไม่สร้าง comments หรือ agent activity สมมติ
- หน้าใหม่ยัง sync ได้, รองรับ theme และเปิดตรงผ่าน hash route ได้โดยไม่ต้องผ่านหน้าเดิม
- ไม่รวม Kanzo backend, MCP server, การสร้าง Jira ticket หรือระบบ agent orchestration ในการเพิ่ม page นี้

ลำดับงาน: เพิ่ม state/actions ของ board → สร้าง page และ styles แบบ scoped → เพิ่ม route/navigation → ทดสอบการไปกลับโดยรักษาหน้าเดิม, project/search, drag/drop และสถานะ AI/Jira ที่เป็นอิสระ → ตรวจภาพจริงทั้ง dark/light และหน้าต่าง 1000×600 → อัปเดตคู่มือ

ใช้ `e2e/ai-board.e2e.ts` ตรวจ user flow ของ page ใหม่ คู่กับ tests เดิม ส่วน logic ที่เพิ่มตรวจด้วย throwaway `node:assert/strict` ผ่าน Bun ไม่มี dependencies ใหม่ การปิดฟีเจอร์ต้องคง schema v3 ไว้เพื่อเปิดข้อมูลเดิมได้ ไม่ downgrade หรือลบฐานข้อมูล

ผลตรวจส่วนหน้าใหม่: unit suite 202 tests และ E2E suite 93 tests ผ่าน รวม 5 เคสของ AI Board; lint/build/e2e type-check และ formatting ผ่าน ตรวจภาพจริง dark/light และขนาด 1000×600 แล้ว หน้าเดิมยังใช้ layout เดิมและ E2E ยืนยัน filter/selection หลังไปกลับ การโหลด board จาก store ที่พร้อมแล้วไม่ reload DB ซ้อน และการย้ายการ์ดผ่าน sync lock เดิม

## 11. สถานะ AI แยกจาก workflow ของคนใน Jira

| การกระทำ              | ผลต่อ AI Board                           | ผลต่อ Jira                              |
| --------------------- | ---------------------------------------- | --------------------------------------- |
| AI เริ่มงาน/รอ review | เปลี่ยน Doing/Review และบันทึกในเครื่อง  | ไม่เปลี่ยนสถานะและไม่ทำให้ dirty        |
| AI ทำเสร็จ            | เปลี่ยน Done                             | ไม่ส่ง transition หรือเปลี่ยน Jira Done |
| คนปิดงานใน Jira       | Pull บันทึก AI Done และ `jiraDone: true` | อ่านผลจาก Jira เท่านั้น                 |
| คนเปิดงาน Jira ใหม่   | ปลด lock แต่คง AI Done จนกว่าจะย้ายเอง   | ไม่ส่งการเปลี่ยนกลับจาก AI              |

- `src/lib/ai-board.ts` เป็น pure model ของคอลัมน์/สถานะ AI การปิดงาน Jira ดู done category รวม custom status และชื่อ legacy ตามพฤติกรรมเดิมของแอป
- เพิ่ม `aiBoardStates` ใน schema v3 โดยคง v1/v2 เดิม ID เป็น task ID ที่แยก account แล้ว พร้อม account index, status, Jira completion flag และ updatedAt
- Pull sync ใช้ task จาก Jira ก่อน merge dirty fields เพื่อให้ Jira Done ปิด AI ได้แม้มี local Jira status ที่ยังไม่ push แล้วส่ง state ที่บันทึกผ่าน `SyncResult` ไป store
- สถานะ AI ใช้ table ของตัวเองจึงไม่ถูก pull/discard หรือการ push task เขียนทับ โหลดแบบ account-scoped และลบทิ้งเมื่อยืนยันลบบัญชี
- UI แยก `AI status` ที่แก้ได้กับ `Jira status` ที่อ่านอย่างเดียว ถ้า Jira ปิดงานแล้ว AI จะอยู่ Done และซ่อน task จากการ์ด/counts/detail โดยไม่ลบข้อมูล ถ้า AI Done แต่ Jira ยังเปิดอยู่ การ์ดยังอยู่ใน Done ไม่มีปุ่ม Push สำหรับสถานะ AI
- สีใช้ theme tokens เดิม: background/card/border/muted สำหรับพื้นฐาน, primary สำหรับ Doing, warning สำหรับ Review, success สำหรับ Done รวม focus ring และปุ่ม ทั้ง light/dark
- จุดตรวจรับ: AI Done ไม่เปลี่ยน Jira/dirty state/เรียก transitions, เก็บสถานะหลัง reload และ offline, Jira Done ปิด AI ทางเดียว, อัปเกรดจาก v2 แล้ว note เดิมอยู่ครบ, ลบบัญชี cleanup AI state, สีเปลี่ยนตาม theme

## 12. ซ่อนงานที่ Jira จบแล้วและซ่อนทั้ง space

- ใช้ completion predicate เดียวกับ AI/Jira one-way completion เพื่อซ่อน Jira Done รวมถึง server completion flag เมื่อมี local Jira status ที่ยังไม่ push การ์ดที่ AI Done แต่ Jira ยังเปิดต้องยังอยู่ในคอลัมน์ Done
- Filter ก่อนคำนวณ counts/รายการ และหา selected/copy task จากชุดที่ไม่ถูกปิดใน Jira จึงปิด detail ของงานที่จบระหว่าง sync ด้วย โดยไม่ลบ task หรือ AI state
- ปุ่มรูปตาข้างแต่ละ project/space ซ่อนทั้งชุดจาก All projects; แสดงแถวชื่อจางพร้อมปุ่มเปิดคืน และยังเลือก space นั้นดูโดยตรงได้
- เก็บ project IDs ใน `jirasync-ai-hidden-projects` ผ่าน store เดิม แยกจาก key ฝั่ง Jira ไม่เพิ่ม schema การซ่อนเปลี่ยนเฉพาะ visibility ของ All projects ไม่เปลี่ยน project/detail ที่กำลังเลือก เหมือนหน้า Jira
- ทดสอบ positive/negative ใน E2E เดิม: Jira Done หายแต่ AI Done ยังอยู่, เปิด Jira ใหม่แล้วงานแสดงกลับ, counts ตรง, ซ่อนแล้วจำหลัง reload, เปิดคืนได้, หน้า Jira ยังเห็นงานและข้อมูลไม่เปลี่ยน

## 13. ตำแหน่งและการใช้งาน controls ให้ตรงกับ Jira

- Search อยู่ฝั่งซ้ายของ toolbar ถัดจากชื่อและจำนวนงาน ใช้ Input เดิม พร้อม Ctrl+F, Escape และปุ่มล้างข้อความ
- ThemeToggle ตัวเดียวอยู่ขวาสุดของ toolbar ถัดจาก Sync เหมือนหน้า Jira; ไม่มีปุ่ม theme ซ้ำใน sidebar
- ไอคอน project อยู่หน้าชื่อและเปลี่ยนเป็นรูปตาเมื่อ hover/focus กดเพื่อ hide/show โดยไม่เลือก project ตาม และไม่ลบข้อมูล
- คงลูกศรซ้ายหน้า My Work ตามเดิม สถานะ AI และ visibility preference ยังคงแยกจาก Jira
