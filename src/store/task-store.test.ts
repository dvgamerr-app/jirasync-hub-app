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

  const organizationRows = new Map<string, Organization>();
  const projectRows = new Map<string, Project>();
  const tasks = new Map<string, StoredTaskRow>();
  const workLogs = new Map<string, StoredWorkLogRow>();

  const getByField = <TRow extends object>(
    collection: Map<string, TRow>,
    field: keyof TRow,
    value: unknown,
  ) => Array.from(collection.values()).filter((item) => Reflect.get(item, field) === value);

  const getByPrefix = <TRow extends object>(
    collection: Map<string, TRow>,
    field: keyof TRow,
    prefix: string,
  ) =>
    Array.from(collection.values()).filter((item) => {
      const fieldValue = Reflect.get(item, field);
      return typeof fieldValue === "string" && fieldValue.startsWith(prefix);
    });

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

  const deleteByPrefix = <TRow extends { id: string }>(
    collection: Map<string, TRow>,
    field: keyof TRow,
    prefix: string,
  ) => {
    Array.from(collection.entries()).forEach(([id, item]) => {
      const fieldValue = Reflect.get(item, field);
      if (typeof fieldValue === "string" && fieldValue.startsWith(prefix)) {
        collection.delete(id);
      }
    });
  };

  const db = {
    organizations: {
      toArray: mock<() => Promise<Organization[]>>(async () => Array.from(organizationRows.values())),
      delete: mock(async () => undefined),
      where: mock((field: keyof Organization) => ({
        equals: mock((value: unknown) => ({
          toArray: mock<() => Promise<Organization[]>>(async () =>
            getByField(organizationRows, field, value),
          ),
          delete: mock(async () => undefined),
        })),
      })),
    },
    projects: {
      toArray: mock<() => Promise<Project[]>>(async () => Array.from(projectRows.values())),
      where: mock((field: keyof Project) => ({
        equals: mock((value: unknown) => ({
          toArray: mock<() => Promise<Project[]>>(async () => getByField(projectRows, field, value)),
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
        startsWith: mock((prefix: string) => ({
          toArray: mock(async () => getByPrefix(tasks, field, prefix)),
          delete: mock(async () => {
            deleteByPrefix(tasks, field, prefix);
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
        startsWith: mock((prefix: string) => ({
          toArray: mock(async () => getByPrefix(workLogs, field, prefix)),
          delete: mock(async () => {
            deleteByPrefix(workLogs, field, prefix);
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
    organizationRows.clear();
    projectRows.clear();
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
    organizationRows,
    projectRows,
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

// var stays available after vi.mock hoisting in the Vitest compatibility layer,
// so it's available for all subsequent module-level and test code.
var mocked: ReturnType<typeof createMockState>;

mock.module("@/lib/jira-db", () => {
  mocked = createMockState();
  return {
    db: mocked.db,
    getJiraAccounts: mocked.getJiraAccounts,
    getStoryPointFieldMap: () => ({}),
  };
});

mock.module("@/lib/jira-api", () => ({
  DEFAULT_STORY_POINT_FIELD_ID: "customfield_10016",
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

    const state = useTaskStore.getState();
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
    expect(state.tasks[0]).toMatchObject({
      id: task.id,
      isDirty: false,
      isSynced: true,
    });
    expect(state.workLogs).toHaveLength(1);
    expect(state.workLogs[0]).toMatchObject({
      id: pendingCreate.id,
      jiraWorklogId: "jira-worklog-new",
      syncStatus: "synced",
    });
    expect(reloadFromDB).not.toHaveBeenCalled();
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

  it("drops from the active list a To Do or In Progress task that was reassigned away from us", () => {
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
    ).toEqual([stillOurs.id]);
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
    mocked.organizationRows.set("org-account-1", {
      id: "org-account-1",
      name: "Account One",
      jiraInstanceUrl: "https://account-1.atlassian.net",
      lastSyncedAt: null,
    });
    mocked.organizationRows.set("org-account-2", {
      id: "org-account-2",
      name: "Account Two",
      jiraInstanceUrl: "https://account-2.atlassian.net",
      lastSyncedAt: null,
    });
    mocked.organizationRows.set("org-account-3", {
      id: "org-account-3",
      name: "Account Three",
      jiraInstanceUrl: "https://account-3.atlassian.net",
      lastSyncedAt: null,
    });
    mocked.projectRows.set(
      "proj-account-2-BETA",
      createProject({
        id: "proj-account-2-BETA",
        orgId: "org-account-2",
        name: "Project Beta",
        jiraProjectKey: "BETA",
      }),
    );
    mocked.projectRows.set(
      "proj-account-1-ALPHA",
      createProject({
        id: "proj-account-1-ALPHA",
        orgId: "org-account-1",
        name: "Project Alpha",
        jiraProjectKey: "ALPHA",
      }),
    );
    mocked.projectRows.set(
      "proj-account-3-OMEGA",
      createProject({
        id: "proj-account-3-OMEGA",
        orgId: "org-account-3",
        name: "Project Omega",
        jiraProjectKey: "OMEGA",
      }),
    );
    mocked.tasks.set(
      "task-account-2-BETA-1",
      createTask({
        id: "task-account-2-BETA-1",
        projectId: "proj-account-2-BETA",
        jiraTaskId: "BETA-1",
        status: "In Progress",
      }),
    );
    mocked.tasks.set(
      "task-account-1-ALPHA-1",
      createTask({
        id: "task-account-1-ALPHA-1",
        projectId: "proj-account-1-ALPHA",
        jiraTaskId: "ALPHA-1",
        status: "In Progress",
      }),
    );
    mocked.tasks.set(
      "task-account-1-GHOST-1",
      createTask({
        id: "task-account-1-GHOST-1",
        projectId: "proj-account-1-MISSING",
        jiraTaskId: "GHOST-1",
        status: "In Progress",
      }),
    );
    mocked.tasks.set(
      "task-account-3-OMEGA-1",
      createTask({
        id: "task-account-3-OMEGA-1",
        projectId: "proj-account-3-OMEGA",
        jiraTaskId: "OMEGA-1",
        status: "In Progress",
      }),
    );
    mocked.workLogs.set(
      "wl-account-1-keep",
      createWorkLog({
        id: "wl-account-1-keep",
        taskId: "task-account-1-ALPHA-1",
      }),
    );
    mocked.workLogs.set(
      "wl-account-1-drop",
      createWorkLog({
        id: "wl-account-1-drop",
        taskId: "task-account-1-GHOST-1",
      }),
    );
    mocked.workLogs.set(
      "wl-account-3-drop",
      createWorkLog({
        id: "wl-account-3-drop",
        taskId: "task-account-3-OMEGA-1",
      }),
    );
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

    expect(mocked.db.organizations.toArray).not.toHaveBeenCalled();
    expect(mocked.db.projects.toArray).not.toHaveBeenCalled();
    expect(mocked.db.tasks.toArray).not.toHaveBeenCalled();
    expect(mocked.db.workLogs.toArray).not.toHaveBeenCalled();
    expect(mocked.db.tasks.where).toHaveBeenCalledWith("id");
    expect(mocked.db.workLogs.where).toHaveBeenCalledWith("taskId");
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
    expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual([
      "task-account-1-ALPHA-1",
      "task-account-2-BETA-1",
    ]);
    expect(useTaskStore.getState().workLogs.map((workLog) => workLog.id)).toEqual([
      "wl-account-1-keep",
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
