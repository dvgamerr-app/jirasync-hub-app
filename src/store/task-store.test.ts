import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkLog } from "@/types/jira";

type StoredTaskRow = Task;
type StoredWorkLogRow = WorkLog;

const mocked = vi.hoisted(() => {
  const accounts = [
    {
      id: "account-1",
      name: "Acme",
      instanceUrl: "https://acme.atlassian.net",
      email: "dev@acme.test",
      apiToken: "token",
    },
  ];

  const tasks = new Map<string, StoredTaskRow>();
  const workLogs = new Map<string, StoredWorkLogRow>();

  const getByField = <TRow extends object>(
    collection: Map<string, TRow>,
    field: keyof TRow,
    value: unknown,
  ) => Array.from(collection.values()).filter((item) => Reflect.get(item, field) === value);

  const deleteByField = <TRow extends { id: string }>(
    collection: Map<string, TRow>,
    field: keyof TRow,
    value: unknown,
  ) => {
    Array.from(collection.entries()).forEach(([id, item]) => {
      if (Reflect.get(item, field) === value) {
        collection.delete(id);
      }
    });
  };

  const deleteByPredicate = <TRow extends { id: string }>(
    collection: Map<string, TRow>,
    predicate: (item: TRow) => boolean,
  ) => {
    Array.from(collection.entries()).forEach(([id, item]) => {
      if (predicate(item)) {
        collection.delete(id);
      }
    });
  };

  const db = {
    organizations: {
      toArray: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          toArray: vi.fn(async () => []),
          delete: vi.fn(async () => undefined),
        })),
      })),
    },
    projects: {
      toArray: vi.fn(async () => []),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          toArray: vi.fn(async () => []),
          delete: vi.fn(async () => undefined),
        })),
      })),
    },
    tasks: {
      put: vi.fn(async (task: StoredTaskRow) => {
        tasks.set(task.id, task);
        return task.id;
      }),
      get: vi.fn(async (id: string) => tasks.get(id)),
      toArray: vi.fn(async () => Array.from(tasks.values())),
      where: vi.fn((field: keyof StoredTaskRow) => ({
        equals: vi.fn((value: unknown) => ({
          toArray: vi.fn(async () => getByField(tasks, field, value)),
          delete: vi.fn(async () => {
            deleteByField(tasks, field, value);
          }),
        })),
      })),
      toCollection: vi.fn(() => ({
        filter: (predicate: (item: StoredTaskRow) => boolean) => ({
          delete: vi.fn(async () => {
            deleteByPredicate(tasks, predicate);
          }),
        }),
      })),
    },
    workLogs: {
      put: vi.fn(async (workLog: StoredWorkLogRow) => {
        workLogs.set(workLog.id, workLog);
        return workLog.id;
      }),
      bulkPut: vi.fn(async (logs: StoredWorkLogRow[]) => {
        logs.forEach((log) => workLogs.set(log.id, log));
      }),
      delete: vi.fn(async (id: string) => {
        workLogs.delete(id);
      }),
      bulkDelete: vi.fn(async (ids: string[]) => {
        ids.forEach((id) => workLogs.delete(id));
      }),
      toArray: vi.fn(async () => Array.from(workLogs.values())),
      where: vi.fn((field: keyof StoredWorkLogRow) => ({
        equals: vi.fn((value: unknown) => ({
          toArray: vi.fn(async () => getByField(workLogs, field, value)),
          delete: vi.fn(async () => {
            deleteByField(workLogs, field, value);
          }),
        })),
      })),
      toCollection: vi.fn(() => ({
        filter: (predicate: (item: StoredWorkLogRow) => boolean) => ({
          delete: vi.fn(async () => {
            deleteByPredicate(workLogs, predicate);
          }),
        }),
      })),
    },
    syncMeta: {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
    },
  };

  const getJiraAccounts = vi.fn(() => accounts);
  const updateJiraIssue = vi.fn(async () => undefined);
  const transitionJiraIssue = vi.fn(async () => undefined);
  const addJiraWorkLog = vi.fn(async () => "jira-worklog-new");
  const deleteJiraWorkLog = vi.fn(async () => undefined);

  const reset = () => {
    tasks.clear();
    workLogs.clear();

    getJiraAccounts.mockClear();
    updateJiraIssue.mockReset().mockResolvedValue(undefined);
    transitionJiraIssue.mockReset().mockResolvedValue(undefined);
    addJiraWorkLog.mockReset().mockResolvedValue("jira-worklog-new");
    deleteJiraWorkLog.mockReset().mockResolvedValue(undefined);

    db.organizations.toArray.mockClear();
    db.organizations.delete.mockClear();
    db.organizations.where.mockClear();
    db.projects.toArray.mockClear();
    db.projects.where.mockClear();
    db.tasks.put.mockClear();
    db.tasks.get.mockClear();
    db.tasks.toArray.mockClear();
    db.tasks.where.mockClear();
    db.tasks.toCollection.mockClear();
    db.workLogs.put.mockClear();
    db.workLogs.bulkPut.mockClear();
    db.workLogs.delete.mockClear();
    db.workLogs.bulkDelete.mockClear();
    db.workLogs.toArray.mockClear();
    db.workLogs.where.mockClear();
    db.workLogs.toCollection.mockClear();
    db.syncMeta.put.mockClear();
    db.syncMeta.get.mockClear();
  };

  return {
    accounts,
    tasks,
    workLogs,
    db,
    getJiraAccounts,
    updateJiraIssue,
    transitionJiraIssue,
    addJiraWorkLog,
    deleteJiraWorkLog,
    reset,
  };
});

vi.mock("@/lib/jira-db", () => ({
  db: mocked.db,
  getJiraAccounts: mocked.getJiraAccounts,
}));

vi.mock("@/lib/jira-api", () => ({
  updateJiraIssue: mocked.updateJiraIssue,
  transitionJiraIssue: mocked.transitionJiraIssue,
  addJiraWorkLog: mocked.addJiraWorkLog,
  deleteJiraWorkLog: mocked.deleteJiraWorkLog,
}));

import { useTaskStore } from "@/store/task-store";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-account-1-ALPHA-1",
    projectId: "proj-account-1-ALPHA",
    jiraTaskId: "ALPHA-1",
    title: "Task alpha",
    description: null,
    status: "In Progress",
    type: "Task",
    severity: "Medium",
    storyLevel: 2,
    mandays: 1,
    assignee: "Alice",
    refUrl: "https://acme.atlassian.net/browse/ALPHA-1",
    note: "Note",
    isSynced: true,
    isDirty: false,
    createdAt: "2026-03-21T10:00:00.000Z",
    updatedAt: "2026-03-21T11:00:00.000Z",
    ...overrides,
  };
}

function createWorkLog(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: "wl-1",
    taskId: "task-account-1-ALPHA-1",
    timeSpentMinutes: 60,
    logDate: "2026-03-21",
    comment: "Worked on it",
    createdAt: "2026-03-21T12:00:00.000Z",
    jiraWorklogId: "jira-worklog-1",
    syncStatus: "synced",
    ...overrides,
  };
}

function seedStore(tasks: Task[], workLogs: WorkLog[]) {
  mocked.tasks.clear();
  tasks.forEach((task) => mocked.tasks.set(task.id, task));

  mocked.workLogs.clear();
  workLogs.forEach((workLog) => mocked.workLogs.set(workLog.id, workLog));

  const reloadFromDB = vi.fn(async () => undefined);

  useTaskStore.setState({
    organizations: [],
    projects: [],
    tasks,
    workLogs,
    isLoaded: true,
    selectedProjectId: null,
    selectedTaskId: null,
    taskDetailViewMode: "details",
    reloadFromDB,
  });

  return { reloadFromDB };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("task-store manual worklog sync", () => {
  beforeEach(() => {
    mocked.reset();
    useTaskStore.setState({
      organizations: [],
      projects: [],
      tasks: [],
      workLogs: [],
      isLoaded: false,
      selectedProjectId: null,
      selectedTaskId: null,
      taskDetailViewMode: "details",
    });
  });

  it("queues new worklogs locally until push sync is requested", async () => {
    const task = createTask();
    seedStore([task], []);

    useTaskStore.getState().addWorkLog({
      taskId: task.id,
      timeSpentMinutes: 90,
      logDate: "2026-03-22",
      comment: "Local only",
      jiraWorklogId: null,
      syncStatus: null,
    });

    await flushAsyncWork();

    const state = useTaskStore.getState();
    expect(mocked.addJiraWorkLog).not.toHaveBeenCalled();
    expect(state.tasks[0]).toMatchObject({ id: task.id, isDirty: true, isSynced: false });
    expect(state.workLogs).toHaveLength(1);
    expect(state.workLogs[0]).toMatchObject({
      taskId: task.id,
      jiraWorklogId: null,
      syncStatus: "pending_create",
      timeSpentMinutes: 90,
      comment: "Local only",
    });
  });

  it("marks synced worklogs for deletion and hides them until push sync", async () => {
    const task = createTask();
    const workLog = createWorkLog();
    seedStore([task], [workLog]);

    useTaskStore.getState().removeWorkLog(workLog.id);

    await flushAsyncWork();

    const state = useTaskStore.getState();
    expect(mocked.deleteJiraWorkLog).not.toHaveBeenCalled();
    expect(state.workLogs).toHaveLength(1);
    expect(state.workLogs[0]).toMatchObject({
      id: workLog.id,
      jiraWorklogId: workLog.jiraWorklogId,
      syncStatus: "pending_delete",
    });
    expect(state.getWorkLogsForTask(task.id)).toEqual([]);
    expect(state.tasks[0]).toMatchObject({ id: task.id, isDirty: true, isSynced: false });
  });

  it("pushes queued worklog creates and deletes only during manual sync", async () => {
    const task = createTask({
      isDirty: true,
      isSynced: false,
      status: null,
      storyLevel: null,
      severity: null,
      mandays: null,
      note: null,
    });
    const pendingCreate = createWorkLog({
      id: "wl-local",
      jiraWorklogId: null,
      syncStatus: "pending_create",
      timeSpentMinutes: 75,
      logDate: "2026-03-22",
      comment: "Queued create",
    });
    const pendingDelete = createWorkLog({
      id: "wl-remote",
      jiraWorklogId: "jira-worklog-delete",
      syncStatus: "pending_delete",
      comment: "Queued delete",
    });
    const { reloadFromDB } = seedStore([task], [pendingCreate, pendingDelete]);

    await useTaskStore.getState().syncTaskToJira(task.id);

    expect(mocked.updateJiraIssue).toHaveBeenCalledOnce();
    expect(mocked.addJiraWorkLog).toHaveBeenCalledWith(
      mocked.accounts[0],
      task.jiraTaskId,
      pendingCreate.timeSpentMinutes,
      pendingCreate.logDate,
      pendingCreate.comment,
    );
    expect(mocked.deleteJiraWorkLog).toHaveBeenCalledWith(
      mocked.accounts[0],
      task.jiraTaskId,
      pendingDelete.jiraWorklogId,
    );
    expect(mocked.db.workLogs.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pendingCreate.id,
        jiraWorklogId: "jira-worklog-new",
        syncStatus: "synced",
      }),
    );
    expect(mocked.db.workLogs.delete).toHaveBeenCalledWith(pendingDelete.id);
    expect(mocked.db.tasks.put).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: task.id,
        isDirty: false,
        isSynced: true,
      }),
    );
    expect(reloadFromDB).toHaveBeenCalledOnce();
  });
});
