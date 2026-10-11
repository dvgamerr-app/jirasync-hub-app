<div align="center">

# JiraSync Hub

**Jira tickets ของคุณ บน desktop แม้ Jira จะช้าหรือออฟไลน์**

ดึงงานที่ assign ให้คุณมาไว้ในเครื่อง แก้ไขและ log เวลาได้แบบออฟไลน์ แล้วส่งกลับ Jira เฉพาะสิ่งที่คุณแก้จริง ไม่ต้องเปิดหน้าเว็บ Jira ให้ช้า

[![Stars](https://img.shields.io/github/stars/dvgamerr-app/jirasync-hub-app?style=for-the-badge&logo=github&color=0052CC)](https://github.com/dvgamerr-app/jirasync-hub-app/stargazers)
[![Release](https://img.shields.io/github/v/release/dvgamerr-app/jirasync-hub-app?style=for-the-badge&color=0052CC)](https://github.com/dvgamerr-app/jirasync-hub-app/releases/latest)
![Platforms](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-0052CC?style=for-the-badge)
![Tauri](https://img.shields.io/badge/Tauri%202-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)

[Website](https://dvgamerr.app/jirasync-hub-app/) · [ดาวน์โหลด](#ติดตั้ง) · [เริ่มใช้งาน](#เริ่มใช้งานใน-4-ขั้นตอน) · [English](README.md)

<img src="docs/screenshots/tasks.png" alt="ตาราง task ของ JiraSync Hub" width="800">

</div>

> ⭐ **ถ้า JiraSync Hub ช่วยประหยัดเวลาคุณได้ กด star ให้หน่อย จะช่วยให้คนใช้ Jira คนอื่นเจอโปรเจกต์นี้ง่ายขึ้น**

## ทำไมต้องใช้

- **ข้อมูลอยู่ในเครื่องคุณ** tasks และ worklogs เก็บใน IndexedDB ค้นหาและแก้ไขได้โดยไม่ต้องต่อเน็ต
- **ส่งเฉพาะที่แก้จริง** แอปติดตามระดับ field ถ้าแค่ log เวลา จะไม่แตะ priority, story point หรือ description ของ ticket
- **Token อยู่ใน keychain ของ OS** API token เก็บใน Windows Credential Manager / macOS Keychain และแอปคุยกับ Jira ตรง ไม่ผ่านเซิร์ฟเวอร์กลาง
- **รายงานเวลาตรงความจริง** worklog ของเพื่อนร่วมทีมแสดงแบบอ่านอย่างเดียว และไม่ถูกนับในยอดเวลาหรือ CSV ของคุณ

## ฟีเจอร์

|     | ฟีเจอร์                         | ทำอะไรได้                                                                       |
| --- | ------------------------------- | ------------------------------------------------------------------------------- |
| 🔄  | **Incremental sync**            | ดึงเฉพาะที่เปลี่ยนทุกชั่วโมงเบื้องหลัง และสั่ง full sync เองได้                 |
| ✏️  | **แก้ไขออฟไลน์**                | Status, type, severity, story level, mandays, note (เก็บในเครื่อง) และ worklogs |
| 🚀  | **Push แบบเลือกได้**            | ส่งทีละ task หรือทั้งหมด โดยดู dirty ระดับ field                                |
| ⏱️  | **Worklogs**                    | เพิ่ม/ลบเวลา มี preview การตีความ (`2` = 2 ชั่วโมง, `1d 4h 30m` ก็ได้)          |
| 🔀  | **เปลี่ยน status ตาม workflow** | ผ่าน Jira transitions ถ้าพลาดจะบอกสาเหตุ                                        |
| ↩️  | **Discard**                     | คืนค่าจาก Jira ได้ทีละ task หรือทั้งหมด                                         |
| 📊  | **Export CSV**                  | รายเดือน, UTF-8 BOM เปิดใน Excel ได้, เตือนถ้ามีเวลาที่ยังไม่ push              |
| 🏢  | **หลาย account**                | หลาย Jira Cloud site พร้อมกัน และตั้ง story point field แยกต่อโปรเจกต์          |
| 🔐  | **Keychain**                    | เก็บ API token ใน credential store ของ OS                                       |
| 🖥️  | **Desktop จริง**                | Tauri 2 บน Windows, macOS, Linux พร้อมระบบอัปเดตในตัว                           |

<details>
<summary>ภาพเพิ่มเติม</summary>

|                                                                                 |                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| <img src="docs/screenshots/task-detail.png" alt="รายละเอียด task และ worklogs"> | <img src="docs/screenshots/export.png" alt="หน้า Export CSV"> |
| <img src="docs/screenshots/settings.png" alt="ตั้งค่า Jira account">            | <img src="docs/screenshots/tasks-light.png" alt="ธีมสว่าง">   |

</details>

## ติดตั้ง

ดาวน์โหลดล่าสุดจาก [**GitHub Releases**](https://github.com/dvgamerr-app/jirasync-hub-app/releases/latest)

| OS      | ไฟล์                                                                            |
| ------- | ------------------------------------------------------------------------------- |
| Windows | `.exe` / `.msi` (มี `.exe` เปิดตรงได้ด้วย ต้องมี WebView2 Runtime)              |
| macOS   | `.dmg` (ยังไม่ผ่าน notarisation ดู[วิธีอนุญาตแอป](docs/user-guide.th.md#macos)) |
| Linux   | `.AppImage` / `.deb`                                                            |

## เริ่มใช้งานใน 4 ขั้นตอน

ต้องมี **Jira Cloud** (`*.atlassian.net`), อีเมล Atlassian และ [API token](https://id.atlassian.net/manage-profile/security/api-tokens)

1. เปิดแอป → **Settings** → **Add Account**
2. กรอก instance (`acme` หรือ `https://acme.atlassian.net`), email, token กด **Test** แล้ว **Save & Connect**
3. กด **Sync** เพื่อดึง projects, tasks และ worklogs
4. แก้ไข task แถวที่แก้จะถูกไฮไลต์จนกว่าจะ push กดปุ่มอัปโหลด (หรือ **Sync** ของ task นั้น) เพื่อส่งกลับ

ไม่รองรับ Jira Server / Data Center

## เอกสาร

- [คู่มือการใช้งานฉบับเต็ม](docs/user-guide.th.md)
- [Architecture](docs/architecture.md)
- [Technical debt](docs/technical-debt.md)

## พัฒนาต่อ

```bash
bun install
bun tauri dev
bun run test
bun run test:e2e   # รันครั้งแรก: bun x playwright install chromium
bun run lint
bun run build
bun run cg:check
```

## สนับสนุนโปรเจกต์

- ⭐ [กด Star](https://github.com/dvgamerr-app/jirasync-hub-app)
- 🐛 [แจ้งปัญหา](https://github.com/dvgamerr-app/jirasync-hub-app/issues)

_ไม่เกี่ยวข้องกับและไม่ได้รับการรับรองจาก Atlassian Jira เป็นเครื่องหมายการค้าของ Atlassian_
