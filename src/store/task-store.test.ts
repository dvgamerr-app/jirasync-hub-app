import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";

type StoredTaskRow = Task;
type StoredWorkLogRow = WorkLog;

// Function declarations are hoisted - available when mock.module factories run
function createMockState() {
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
      toArray: mock<() => Promise<Organization[]>>(async () => []),
      delete: mock(async () => undefined),
      where: mock(() => ({
        equals: mock(() => ({
          toArray: mock<() => Promise<Organization[]>>(async () => []),
          delete: mock(async () => undefined),
        })),
      })),
    },
    projects: {
      toArray: mock<() => Promise<Project[]>>(async () => []),
      where: mock(() => ({
        equals: mock(() => ({
          toArray: mock<() => Promise<Project[]>>(async () => []),
          delete: mock(async () => undefined),
        })),
      })),
    },
    tasks: {
      put: mock(async (task: StoredTaskRow) => {
        tasks.set(task.id, task);
        return task.id;
      }),
      get: mock(async (id: string) => tasks.get(id)),
      toArray: mock(async () => Array.from(tasks.values())),
      where: mock((field: keyof StoredTaskRow) => ({
        equals: mock((value: unknown) => ({
          toArray: mock(async () => getByField(tasks, field, value)),
          delete: mock(async () => {
            deleteByField(tasks, field, value);
          }),
        })),
      })),
      toCollection: mock(() => ({
        filter: (predicate: (item: StoredTaskRow) => boolean) => ({
          delete: mock(async () => {
            deleteByPredicate(tasks, predicate);
          }),
        }),
      })),
    },
    workLogs: {
      put: mock(async (workLog: StoredWorkLogRow) => {
        workLogs.set(workLog.id, workLog);
        return workLog.id;
      }),
      bulkPut: mock(async (logs: StoredWorkLogRow[]) => {
        logs.forEach((log) => workLogs.set(log.id, log));
      }),
      delete: mock(async (id: string) => {
        workLogs.delete(id);
      }),
      bulkDelete: mock(async (ids: string[]) => {
        ids.forEach((id) => workLogs.delete(id));
      }),
      toArray: mock(async () => Array.from(workLogs.values())),
      where: mock((field: keyof StoredWorkLogRow) => ({
        equals: mock((value: unknown) => ({
          toArray: mock(async () => getByField(workLogs, field, value)),
          delete: mock(async () => {
            deleteByField(workLogs, field, value);
          }),
        })),
      })),
      toCollection: mock(() => ({
        filter: (predicate: (item: StoredWorkLogRow) => boolean) => ({
          delete: mock(async () => {
            deleteByPredicate(workLogs, predicate);
          }),
        }),
      })),
    },
    syncMeta: {
      put: mock(async () => undefined),
      get: mock(async () => undefined),
    },
  };

  const getJiraAccounts = mock(() => accounts);
  const updateJiraIssue = mock(async () => undefined);
  const transitionJiraIssue = mock(async () => undefined);
  const addJiraWorkLog = mock(async () => "jira-worklog-new");
  const deleteJiraWorkLog = mock(async () => undefined);

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
}

// var is hoisted as undefined; assigned inside the mock.module factory
// so it's available for all subsequent module-level and test code
let mocked: ReturnType<typeof createMockState>;

mock.module("@/lib/jira-db", () => {
  mocked = createMockState();
  return {
    db: mocked.db,
    getJiraAccounts: mocked.getJiraAccounts,
    getStoryPointFieldMap: () => ({}),
  };
});

mock.module("@/lib/jira-api", () => ({
  get updateJiraIssue() {
    return mocked?.updateJiraIssue;
  },
  get transitionJiraIssue() {
    return mocked?.transitionJiraIssue;
  },
  get addJiraWorkLog() {
    return mocked?.addJiraWorkLog;
  },
  get deleteJiraWorkLog() {
    return mocked?.deleteJiraWorkLog;
  },
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

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-account-1-ALPHA",
    orgId: "org-account-1",
    name: "Project Alpha",
    jiraProjectKey: "ALPHA",
    availableStatuses: ["To Do", "In Progress", "Done"],
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

function seedStore(tasks: Task[], workLogs: WorkLog[], projects: Project[] = []) {
  mocked.tasks.clear();
  tasks.forEach((task) => mocked.tasks.set(task.id, task));

  mocked.workLogs.clear();
  workLogs.forEach((workLog) => mocked.workLogs.set(workLog.id, workLog));

  const reloadFromDB = mock(async () => undefined);

  useTaskStore.setState({
    organizations: [],
    projects,
    tasks,
    workLogs,
    isLoaded: true,
    selectedProjectId: null,
    selectedTaskId: null,
    taskStatusFilter: "active",
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
      taskStatusFilter: "active",
      taskDetailViewMode: "details",
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
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

describe("task-store task status filters", () => {
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
      taskStatusFilter: "active",
      taskDetailViewMode: "details",
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
    });
  });

  it("shows only non-done tasks by default, supports done and all filters", () => {
    const project = createProject();
    const activeTask = createTask({
      id: "task-account-1-ALPHA-1",
      jiraTaskId: "ALPHA-1",
      status: "In Progress",
      createdAt: "2026-03-21T10:00:00.000Z",
    });
    const doneTask = createTask({
      id: "task-account-1-ALPHA-2",
      jiraTaskId: "ALPHA-2",
      status: "Done",
      createdAt: "2026-03-21T12:00:00.000Z",
    });
    seedStore([activeTask, doneTask], [], [project]);

    expect(useTaskStore.getState().taskStatusFilter).toBe("active");
    expect(
      useTaskStore
        .getState()
        .getFilteredTasks()
        .map((task) => task.id),
    ).toEqual([activeTask.id]);

    useTaskStore.getState().setTaskStatusFilter("done");
    expect(
      useTaskStore
        .getState()
        .getFilteredTasks()
        .map((task) => task.id),
    ).toEqual([doneTask.id]);

    useTaskStore.getState().setTaskStatusFilter("all");
    expect(
      useTaskStore
        .getState()
        .getFilteredTasks()
        .map((task) => task.id),
    ).toEqual([doneTask.id, activeTask.id]);
  });

  it("drops from the active list a To Do task that was reassigned away from us, but keeps it once it's in progress", () => {
    const project = createProject();
    const stillOurs = createTask({
      id: "task-account-1-ALPHA-1",
      jiraTaskId: "ALPHA-1",
      status: "To Do",
      statusCategory: "new",
      isCurrentAssignee: true,
      createdAt: "2026-03-21T10:00:00.000Z",
    });
    const reassignedBeforeStart = createTask({
      id: "task-account-1-ALPHA-2",
      jiraTaskId: "ALPHA-2",
      status: "To Do",
      statusCategory: "new",
      isCurrentAssignee: false,
      createdAt: "2026-03-21T11:00:00.000Z",
    });
    const reassignedAfterStart = createTask({
      id: "task-account-1-ALPHA-3",
      jiraTaskId: "ALPHA-3",
      status: "In Progress",
      statusCategory: "indeterminate",
      isCurrentAssignee: false,
      createdAt: "2026-03-21T12:00:00.000Z",
    });
    seedStore([stillOurs, reassignedBeforeStart, reassignedAfterStart], [], [project]);

    expect(
      useTaskStore
        .getState()
        .getFilteredTasks()
        .map((task) => task.id),
    ).toEqual([reassignedAfterStart.id, stillOurs.id]);
  });

  it("clears the selected task when it no longer matches the active filter", () => {
    const project = createProject();
    const activeTask = createTask({
      id: "task-account-1-ALPHA-1",
      jiraTaskId: "ALPHA-1",
      status: "In Progress",
    });
    const doneTask = createTask({
      id: "task-account-1-ALPHA-2",
      jiraTaskId: "ALPHA-2",
      status: "Done",
    });
    seedStore([activeTask, doneTask], [], [project]);

    useTaskStore.setState({ selectedTaskId: doneTask.id, taskStatusFilter: "all" });

    useTaskStore.getState().setTaskStatusFilter("active");

    expect(useTaskStore.getState().selectedTaskId).toBeNull();
  });

  it("hides projects that have no tasks left for the current filter", () => {
    const activeProject = createProject({
      id: "proj-account-1-ALPHA",
      name: "Project Alpha",
      jiraProjectKey: "ALPHA",
    });
    const doneOnlyProject = createProject({
      id: "proj-account-1-BETA",
      name: "Project Beta",
      jiraProjectKey: "BETA",
    });
    const activeTask = createTask({
      id: "task-account-1-ALPHA-1",
      projectId: activeProject.id,
      jiraTaskId: "ALPHA-1",
      status: "In Progress",
    });
    const doneTask = createTask({
      id: "task-account-1-BETA-1",
      projectId: doneOnlyProject.id,
      jiraTaskId: "BETA-1",
      status: "Done",
    });
    seedStore([activeTask, doneTask], [], [activeProject, doneOnlyProject]);

    useTaskStore.setState({ selectedProjectId: doneOnlyProject.id, taskStatusFilter: "all" });

    useTaskStore.getState().setTaskStatusFilter("active");

    expect(
      useTaskStore
        .getState()
        .getVisibleProjects()
        .map((project) => project.id),
    ).toEqual([activeProject.id]);
    expect(useTaskStore.getState().selectedProjectId).toBeNull();
  });

  it("orders visible projects by Jira connection order", async () => {
    mocked.db.organizations.toArray.mockResolvedValue([
      {
        id: "org-account-1",
        name: "Account One",
        jiraInstanceUrl: "https://account-1.atlassian.net",
        lastSyncedAt: null,
      },
      {
        id: "org-account-2",
        name: "Account Two",
        jiraInstanceUrl: "https://account-2.atlassian.net",
        lastSyncedAt: null,
      },
    ]);
    mocked.db.projects.toArray.mockResolvedValue([
      createProject({
        id: "proj-account-2-BETA",
        orgId: "org-account-2",
        name: "Project Beta",
        jiraProjectKey: "BETA",
      }),
      createProject({
        id: "proj-account-1-ALPHA",
        orgId: "org-account-1",
        name: "Project Alpha",
        jiraProjectKey: "ALPHA",
      }),
    ]);
    mocked.db.tasks.toArray.mockResolvedValue([
      createTask({
        id: "task-account-2-BETA-1",
        projectId: "proj-account-2-BETA",
        jiraTaskId: "BETA-1",
        status: "In Progress",
      }),
      createTask({
        id: "task-account-1-ALPHA-1",
        projectId: "proj-account-1-ALPHA",
        jiraTaskId: "ALPHA-1",
        status: "In Progress",
      }),
    ]);
    mocked.db.workLogs.toArray.mockResolvedValue([]);
    mocked.getJiraAccounts.mockReturnValue([
      mocked.accounts[0],
      {
        id: "account-2",
        name: "Second",
        instanceUrl: "https://account-2.atlassian.net",
        email: "dev2@acme.test",
        apiToken: "token-2",
      },
    ]);

    await useTaskStore.getState().loadFromDB();

    expect(
      useTaskStore
        .getState()
        .getVisibleProjects()
        .map((project) => project.id),
    ).toEqual(["proj-account-1-ALPHA", "proj-account-2-BETA"]);
    expect(useTaskStore.getState().organizations.map((organization) => organization.id)).toEqual([
      "org-account-1",
      "org-account-2",
    ]);
  });
});

describe("task-store story level rules", () => {
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
      taskStatusFilter: "active",
      taskDetailViewMode: "details",
      searchQuery: "",
      hiddenProjectIds: new Set<string>(),
    });
  });

  it("rejects assigning story level to non-story tasks", async () => {
    const task = createTask({
      type: "Task",
      storyLevel: null,
      isDirty: false,
      isSynced: true,
    });
    seedStore([task], []);

    useTaskStore.getState().updateTaskStoryLevel(task.id, 3);

    await flushAsyncWork();

    const state = useTaskStore.getState();
    expect(state.tasks[0]).toMatchObject({
      id: task.id,
      storyLevel: null,
      isDirty: false,
      isSynced: true,
    });
    expect(mocked.db.tasks.put).not.toHaveBeenCalled();
  });

  it("allows clearing an invalid story level on non-story tasks", async () => {
    const task = createTask({
      type: "Task",
      storyLevel: 2,
      isDirty: false,
      isSynced: true,
    });
    seedStore([task], []);

    useTaskStore.getState().updateTaskStoryLevel(task.id, null);

    await flushAsyncWork();

    const state = useTaskStore.getState();
    expect(state.tasks[0]).toMatchObject({
      id: task.id,
      storyLevel: null,
      isDirty: true,
      isSynced: false,
    });
    expect(mocked.db.tasks.put).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        storyLevel: null,
        isDirty: true,
        isSynced: false,
      }),
    );
  });
});
