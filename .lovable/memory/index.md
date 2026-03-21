Design system: cool neutral palette with blue primary (220 85% 55%), success/warning/info tokens. Inter font, 13px base.
Architecture: Zustand store + IndexedDB (Dexie.js) for persistence. localStorage for Jira credentials. Background sync every 1hr.
Key files: src/store/task-store.ts (state), src/types/jira.ts (types), src/lib/jira-db.ts (Dexie DB), src/lib/jira-api.ts (Jira REST client), src/lib/sync-service.ts (background sync).
Components: AppSidebar (with JiraSettings gear), TaskTable, TaskDetailPanel, CommandMenu, StatusBadge, JiraSettings dialog.
No backend/edge functions — Jira API called directly from browser. CORS may need proxy or browser extension.
