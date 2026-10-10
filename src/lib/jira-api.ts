import { getJiraBaseUrl, getStoryPointFieldMap, type JiraAccount } from "./jira-db";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";
import { fetch } from "@tauri-apps/plugin-http";
import { getOrganizationId, getProjectId, getTaskId } from "@/lib/jira-ids";
import { getErrorMessage, mapWithConcurrency } from "@/lib/utils";

export const DEFAULT_STORY_POINT_FIELD_ID = "customfield_10016";
const SECONDS_PER_WORKDAY = 8 * 60 * 60; // 8 hours in seconds
const LINKED_ISSUES_BATCH_SIZE = 50;
/** Max simultaneous per-issue worklog requests during a pull. */
const WORKLOG_FETCH_CONCURRENCY = 4;

const SEVERITY_PATTERNS: [RegExp, Task["severity"]][] = [
  [/critical|highest|blocker/, "Critical"],
  [/high/, "High"],
  [/medium|normal/, "Medium"],
  [/low/, "Low"],
];

type JiraAdfNode = {
  type?: string;
  text?: string;
  content?: JiraAdfNode[];
};

type JiraTextContent = JiraAdfNode | string | null | undefined;

type JiraNamedField = {
  name?: string | null;
};

type JiraStatusField = JiraNamedField & {
  statusCategory?: { key?: string | null } | null;
};

type JiraUser = {
  accountId?: string | null;
  displayName?: string | null;
};

type JiraProjectField = {
  key?: string | null;
  name?: string | null;
};

type JiraWorklog = {
  id: string;
  author?: JiraUser | null;
  timeSpentSeconds?: number | null;
  started: string;
  comment?: JiraTextContent;
};

type JiraIssueLinkEntry = {
  inwardIssue?: { key: string } | null;
  outwardIssue?: { key: string } | null;
};

type JiraIssueFields = {
  summary?: string | null;
  description?: JiraTextContent;
  status?: JiraStatusField | null;
  issuetype?: JiraNamedField | null;
  priority?: JiraNamedField | null;
  assignee?: JiraUser | null;
  creator?: JiraUser | null;
  customfield_10016?: number | null;
  [key: string]: unknown; // allow dynamic custom fields (e.g. story point overrides)
  timetracking?: {
    originalEstimateSeconds?: number | null;
  } | null;
  parent?: { key?: string | null } | null;
  project?: JiraProjectField | null;
  created: string;
  updated: string;
  worklog?: {
    worklogs?: JiraWorklog[];
    total?: number | null;
    maxResults?: number | null;
  } | null;
  issuelinks?: JiraIssueLinkEntry[] | null;
};

type JiraIssue = {
  key: string;
  archived?: boolean;
  fields: JiraIssueFields;
};

type JiraProjectSearchResponse = {
  values?: Array<{
    key: string;
    name: string;
  }>;
  isLast?: boolean;
};

type JiraProjectStatus = {
  name?: string | null;
};

type JiraProjectIssueTypeStatuses = {
  name?: string | null;
  statuses?: JiraProjectStatus[] | null;
};

type JiraMyselfResponse = JiraUser;

type JiraServerInfoResponse = {
  serverTitle?: string | null;
  baseUrl?: string | null;
};

type JiraSearchResponse = {
  issues?: JiraIssue[];
  isLast?: boolean;
  nextPageToken?: string;
};

type JiraTransition = {
  id: string;
  name?: string | null;
  to?: JiraNamedField | null;
};

type JiraTransitionsResponse = {
  transitions?: JiraTransition[];
};

type JiraCreatedWorklogResponse = {
  id?: string | null;
};

type JiraWorklogListResponse = {
  startAt?: number;
  maxResults?: number;
  total?: number;
  worklogs?: JiraWorklog[];
};

export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string };
}

type AssignedJiraData = {
  projects: Project[];
  tasks: Task[];
  worklogsByTaskId: Record<string, WorkLog[]>;
  /** Tasks whose complete worklog list could not be fetched; their local worklogs must be kept. */
  worklogFetchFailedTaskIds: string[];
};

export const TOKEN_UNAVAILABLE_MESSAGE =
  "The API token for this account could not be read from the OS keychain (it may be missing, or access was denied — macOS asks for permission, and asks again after an app update). Open Settings and enter the API token again, and choose Always Allow if the system asks.";

function getAuthHeader(account: JiraAccount): string {
  if (!account.apiToken) throw new Error(TOKEN_UNAVAILABLE_MESSAGE);
  return "Basic " + btoa(`${account.email}:${account.apiToken}`);
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function jiraFetch(
  path: string,
  account: JiraAccount,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = getJiraBaseUrl(account);
  const url = `${baseUrl}/rest/api/3/${path}`;
  const headers: Record<string, string> = {
    Authorization: getAuthHeader(account),
    Accept: "application/json",
    ...normalizeHeaders(options.headers),
  };
  if (options.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: "omit",
      headers,
    });
  } catch (err: unknown) {
    // The Tauri http plugin can reject with a bare string (e.g. DNS failure,
    // TLS error, or a URL blocked by the http capability scope) instead of
    // an Error, so normalize it into a message that's actually readable.
    throw new Error(`Could not reach ${url}: ${getErrorMessage(err)}`, { cause: err });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira API ${res.status}: ${text}`);
  }
  return res;
}

// Test connection
export async function testJiraConnection(account: JiraAccount): Promise<boolean> {
  try {
    await jiraFetch("myself", account);
    return true;
  } catch {
    return false;
  }
}

export async function fetchJiraMyselfDisplayName(account: JiraAccount): Promise<string> {
  const res = await jiraFetch("myself", account);
  const data = (await res.json()) as JiraMyselfResponse;
  return data.displayName ?? account.name ?? account.email;
}

async function fetchJiraMyself(account: JiraAccount): Promise<JiraMyselfResponse> {
  const res = await jiraFetch("myself", account);
  return (await res.json()) as JiraMyselfResponse;
}

// Fetch all projects (paginated)
export async function fetchJiraProjects(account: JiraAccount): Promise<Project[]> {
  const orgId = getOrganizationId(account.id);
  const projects: Project[] = [];
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const res = await jiraFetch(
      `project/search?maxResults=${maxResults}&startAt=${startAt}&expand=description`,
      account,
    );
    const data = (await res.json()) as JiraProjectSearchResponse;

    for (const p of data.values ?? []) {
      projects.push({
        id: getProjectId(account.id, p.key),
        orgId,
        name: p.name,
        jiraProjectKey: p.key,
        availableStatuses: [],
      });
    }

    if (data.isLast) break;
    startAt += maxResults;
  }

  return projects;
}

// Fetch organization info
export async function fetchJiraOrganization(account: JiraAccount): Promise<Organization> {
  const baseUrl = getJiraBaseUrl(account);
  const res = await jiraFetch("serverInfo", account);
  const data = (await res.json()) as JiraServerInfoResponse;

  return {
    id: getOrganizationId(account.id),
    name: account.name || data.serverTitle || data.baseUrl || baseUrl,
    jiraInstanceUrl: baseUrl,
    lastSyncedAt: new Date().toISOString(),
  };
}

// Extract plain text from Atlassian Document Format (ADF)
function adfToText(node: JiraTextContent): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    const sep = node.type === "paragraph" || node.type === "heading" ? "\n" : "";
    return node.content.map(adfToText).join("") + sep;
  }
  return "";
}

/** Fetches all custom Jira fields for the account, sorted by name. */
export async function fetchJiraFields(account: JiraAccount): Promise<JiraField[]> {
  const res = await jiraFetch("field", account);
  const data = (await res.json()) as JiraField[];
  return data.filter((f) => f.custom).sort((a, b) => a.name.localeCompare(b.name));
}

export type StoryPointCandidate = JiraField & { occurrences: number };

/**
 * Samples up to 20 recent issues from a project and finds which numeric custom
 * fields actually have values — so the user doesn't have to guess from a list
 * of identically-named "Story Point" fields.
 *
 * @param numericFields - pre-fetched list of numeric custom fields (from fetchJiraFields)
 */
export async function detectStoryPointCandidates(
  account: JiraAccount,
  projectKey: string,
  numericFields: JiraField[],
): Promise<StoryPointCandidate[]> {
  if (numericFields.length === 0) return [];

  const fieldIds = numericFields.map((f) => f.id);

  try {
    const res = await jiraFetch("search/jql", account, {
      method: "POST",
      body: JSON.stringify({
        jql: `project = "${projectKey}" ORDER BY updated DESC`,
        maxResults: 20,
        fields: fieldIds,
      }),
    });
    const data = (await res.json()) as JiraSearchResponse;
    const issues = data.issues ?? [];

    const counts = new Map<string, number>();
    for (const issue of issues) {
      for (const fieldId of fieldIds) {
        if (issue.fields[fieldId] != null) {
          counts.set(fieldId, (counts.get(fieldId) ?? 0) + 1);
        }
      }
    }

    return numericFields
      .filter((f) => counts.has(f.id))
      .map((f) => ({ ...f, occurrences: counts.get(f.id)! }))
      .sort((a, b) => b.occurrences - a.occurrences);
  } catch {
    return [];
  }
}

function normalizeStoryLevel(value: number | null | undefined): Task["storyLevel"] {
  switch (value) {
    case 1:
    case 2:
    case 3:
    case 5:
      return value;
    default:
      return null;
  }
}

function mapStatusCategory(key: string | null | undefined): Task["statusCategory"] {
  if (key === "new" || key === "indeterminate" || key === "done") return key;
  return null;
}

function mapIssueToTask(
  issue: JiraIssue,
  account: JiraAccount,
  projectKey: string,
  storyPointFieldId = DEFAULT_STORY_POINT_FIELD_ID,
  currentUser: JiraMyselfResponse | null = null,
): Task {
  const desc = issue.fields.description;
  // Preserve raw ADF as JSON string so the renderer can produce rich output.
  // Fall back to adfToText for plain-string descriptions from older API versions.
  const description = desc
    ? typeof desc === "string"
      ? desc
      : desc.type === "doc"
        ? JSON.stringify(desc)
        : adfToText(desc).trim() || null
    : null;

  const issueTypeName = issue.fields.issuetype?.name ?? "";
  const isEpic = issueTypeName === "Epic";
  const type: Task["type"] = isEpic ? null : issueTypeName || null;
  const assignee = issue.fields.assignee?.displayName ?? null;
  const assigneeAccountId = issue.fields.assignee?.accountId ?? null;
  const creatorAccountId = issue.fields.creator?.accountId ?? null;
  const isSameUser = (accountId: string | null, displayName: string | null): boolean | null => {
    if (currentUser?.accountId && accountId) return currentUser.accountId === accountId;
    if (currentUser?.displayName && displayName) return currentUser.displayName === displayName;
    return currentUser == null ? null : false;
  };

  return {
    id: getTaskId(account.id, issue.key),
    projectId: getProjectId(account.id, projectKey),
    jiraTaskId: issue.key,
    title: issue.fields.summary ?? "",
    description,
    status: issue.fields.status?.name ?? null,
    type,
    isEpic,
    parentKey: issue.fields.parent?.key ?? null,
    severity: mapPriorityToSeverity(issue.fields.priority?.name),
    storyLevel: normalizeStoryLevel(issue.fields[storyPointFieldId] as number | null | undefined),
    mandays:
      issue.fields.timetracking?.originalEstimateSeconds != null
        ? Math.round(
            (issue.fields.timetracking.originalEstimateSeconds / SECONDS_PER_WORKDAY) * 1000,
          ) / 1000
        : null,
    assignee,
    statusCategory: mapStatusCategory(issue.fields.status?.statusCategory?.key),
    isCurrentAssignee: isSameUser(assigneeAccountId, assignee),
    isCreatedByCurrentUser: isSameUser(creatorAccountId, issue.fields.creator?.displayName ?? null),
    refUrl: `${getJiraBaseUrl(account)}/browse/${issue.key}`,
    note: null,
    isArchived: issue.archived ?? false,
    isSynced: true,
    isDirty: false,
    createdAt: issue.fields.created,
    updatedAt: issue.fields.updated,
  };
}

function mergeStatuses(primary: Iterable<string>, secondary: Iterable<string>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const status of primary) {
    if (!status || seen.has(status)) continue;
    seen.add(status);
    merged.push(status);
  }

  for (const status of secondary) {
    if (!status || seen.has(status)) continue;
    seen.add(status);
    merged.push(status);
  }

  return merged;
}

type ProjectMetadata = {
  statuses: string[];
  issueTypes: string[];
};

async function fetchProjectMetadata(
  account: JiraAccount,
  projectKey: string,
): Promise<ProjectMetadata> {
  const res = await jiraFetch(`project/${encodeURIComponent(projectKey)}/statuses`, account);
  const data = (await res.json()) as JiraProjectIssueTypeStatuses[];

  const statuses = [
    ...new Set(
      (data ?? []).flatMap((it) => (it.statuses ?? []).map((s) => s.name ?? "").filter(Boolean)),
    ),
  ];

  const issueTypes = [...new Set((data ?? []).map((it) => it.name ?? "").filter(Boolean))];

  return { statuses, issueTypes };
}

function buildProjectEntry(
  account: JiraAccount,
  projectKey: string,
  projectName: string | null | undefined,
): Project {
  return {
    id: getProjectId(account.id, projectKey),
    orgId: getOrganizationId(account.id),
    name: projectName ?? projectKey,
    jiraProjectKey: projectKey,
    availableStatuses: [],
  };
}

function addProjectStatus(map: Map<string, Set<string>>, projectId: string, status: string): void {
  const set = map.get(projectId) ?? new Set<string>();
  set.add(status);
  map.set(projectId, set);
}

type IssueCollections = {
  projectMap: Map<string, Project>;
  statusSetByProjectId: Map<string, Set<string>>;
  tasks: Task[];
  worklogsByTaskId: Record<string, WorkLog[]>;
  truncatedIssueKeys: Map<string, string>;
  fetchedKeys: Set<string>;
  storyPointFieldMap: Record<string, string>;
  currentUser: JiraMyselfResponse | null;
};

function processIssueIntoCollections(
  issue: JiraIssue,
  account: JiraAccount,
  cols: IssueCollections,
): void {
  const projectKey = issue.fields.project?.key;
  if (!projectKey) return;

  cols.fetchedKeys.add(issue.key);

  const projectId = getProjectId(account.id, projectKey);
  if (!cols.projectMap.has(projectKey)) {
    cols.projectMap.set(
      projectKey,
      buildProjectEntry(account, projectKey, issue.fields.project?.name),
    );
  }

  const status = issue.fields.status?.name ?? null;
  if (status) addProjectStatus(cols.statusSetByProjectId, projectId, status);

  const storyPointFieldId = cols.storyPointFieldMap[projectId] ?? DEFAULT_STORY_POINT_FIELD_ID;
  const task = mapIssueToTask(issue, account, projectKey, storyPointFieldId, cols.currentUser);
  cols.tasks.push(task);

  resolveWorklogs(
    issue.key,
    task.id,
    issue,
    cols.worklogsByTaskId,
    cols.truncatedIssueKeys,
    cols.currentUser,
  );
}

export type FetchAssignedOptions = {
  /**
   * Incremental pull: only issues updated within the last N minutes. Relative JQL durations are
   * used on purpose — absolute date-times are interpreted in the Jira user's profile time zone.
   * Omit for a full pull of everything the user is or was involved in.
   */
  updatedWithinMinutes?: number;
};

function buildIssueFields(storyPointFieldMap: Record<string, string>): string[] {
  // Every story-point field configured for any project, plus the default.
  const storyPointFieldIds = new Set([DEFAULT_STORY_POINT_FIELD_ID]);
  for (const fieldId of Object.values(storyPointFieldMap)) {
    if (fieldId) storyPointFieldIds.add(fieldId);
  }
  return [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "creator",
    "description",
    "created",
    "updated",
    ...storyPointFieldIds,
    "parent",
    "worklog",
    "timetracking",
    "project",
    "issuelinks",
  ];
}

/** Pages through the main JQL query; returns the keys of issues linked from the results. */
async function fetchMainQueryIssues(
  account: JiraAccount,
  jql: string,
  fields: string[],
  cols: IssueCollections,
): Promise<Set<string>> {
  const linkedKeys = new Set<string>();
  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = { jql, maxResults: 100, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await jiraFetch("search/jql", account, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as JiraSearchResponse;

    for (const issue of data.issues ?? []) {
      processIssueIntoCollections(issue, account, cols);
      for (const link of issue.fields.issuelinks ?? []) {
        const key = link.inwardIssue?.key ?? link.outwardIssue?.key;
        if (key) linkedKeys.add(key);
      }
    }

    nextPageToken = data.isLast ? undefined : data.nextPageToken;
  } while (nextPageToken);

  return linkedKeys;
}

/** Fetches issues by key (linked issues, parent epics). A failed batch is skipped, not fatal. */
async function fetchIssuesByKeys(
  account: JiraAccount,
  keys: string[],
  fields: string[],
  cols: IssueCollections,
  label: string,
): Promise<void> {
  for (let i = 0; i < keys.length; i += LINKED_ISSUES_BATCH_SIZE) {
    const batch = keys.slice(i, i + LINKED_ISSUES_BATCH_SIZE);
    const jql = `issueKey in (${batch.map((k) => `"${k}"`).join(",")})`;
    try {
      const res = await jiraFetch("search/jql", account, {
        method: "POST",
        body: JSON.stringify({ jql, maxResults: LINKED_ISSUES_BATCH_SIZE, fields }),
      });
      const data = (await res.json()) as JiraSearchResponse;
      for (const issue of data.issues ?? []) {
        if (!cols.fetchedKeys.has(issue.key)) processIssueIntoCollections(issue, account, cols);
      }
    } catch (error: unknown) {
      console.warn(`Failed fetching ${label} batch:`, error);
    }
  }
}

async function attachProjectMetadata(
  account: JiraAccount,
  cols: IssueCollections,
): Promise<Project[]> {
  const collectedProjects = Array.from(cols.projectMap.values());
  const projectMetaResults = await Promise.allSettled(
    collectedProjects.map((project) => fetchProjectMetadata(account, project.jiraProjectKey)),
  );

  return collectedProjects.map((project, index) => {
    const metaResult = projectMetaResults[index];
    if (metaResult.status === "rejected") {
      console.warn(
        `Failed fetching metadata for project ${project.jiraProjectKey}:`,
        metaResult.reason,
      );
    }

    const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
    return {
      ...project,
      availableStatuses: mergeStatuses(
        meta?.statuses ?? [],
        cols.statusSetByProjectId.get(project.id) ?? [],
      ),
      availableIssueTypes: meta?.issueTypes ?? [],
    };
  });
}

export async function fetchAssignedJiraData(
  account: JiraAccount,
  options: FetchAssignedOptions = {},
): Promise<AssignedJiraData> {
  const currentUser = await fetchJiraMyself(account).catch(() => null);
  const storyPointFieldMap = getStoryPointFieldMap();
  const fields = buildIssueFields(storyPointFieldMap);

  const involvement =
    "(assignee = currentUser() OR assignee was currentUser() OR creator = currentUser())";
  const updatedFilter =
    options.updatedWithinMinutes !== undefined
      ? ` AND updated >= -${Math.max(1, Math.ceil(options.updatedWithinMinutes))}m`
      : "";
  const jql = `${involvement}${updatedFilter} ORDER BY updated DESC`;

  const cols: IssueCollections = {
    projectMap: new Map(),
    statusSetByProjectId: new Map(),
    tasks: [],
    worklogsByTaskId: {},
    truncatedIssueKeys: new Map(),
    fetchedKeys: new Set(),
    storyPointFieldMap,
    currentUser,
  };

  const linkedKeys = await fetchMainQueryIssues(account, jql, fields, cols);

  // Fetch linked issues that weren't already returned by the main query
  const unfetchedLinkedKeys = Array.from(linkedKeys).filter((k) => !cols.fetchedKeys.has(k));
  await fetchIssuesByKeys(account, unfetchedLinkedKeys, fields, cols, "linked issues");

  // Fetch parent epics not returned by the main JQL (they may not be assigned to the user)
  const unfetchedParentKeys = cols.tasks
    .filter((t) => t.parentKey && !cols.fetchedKeys.has(t.parentKey))
    .map((t) => t.parentKey as string)
    .filter((key, i, arr) => arr.indexOf(key) === i);
  await fetchIssuesByKeys(account, unfetchedParentKeys, fields, cols, "parent epics");

  const worklogFetchFailedTaskIds = await fetchTruncatedWorklogs(
    account,
    cols.truncatedIssueKeys,
    cols.worklogsByTaskId,
    cols.currentUser,
  );

  return {
    projects: await attachProjectMetadata(account, cols),
    tasks: cols.tasks,
    worklogsByTaskId: cols.worklogsByTaskId,
    worklogFetchFailedTaskIds,
  };
}

export type FreshJiraTask = { task: Task; workLogs: WorkLog[] };

/**
 * Re-fetches a single issue straight from Jira, bypassing any local dirty
 * merge — used to discard unsynced local edits and restore the task/worklogs
 * to whatever is actually in Jira right now.
 */
export async function fetchFreshJiraTask(
  account: JiraAccount,
  issueKey: string,
): Promise<FreshJiraTask> {
  const currentUser = await fetchJiraMyself(account).catch(() => null);
  const storyPointFieldMap = getStoryPointFieldMap();
  const fields = buildIssueFields(storyPointFieldMap);

  const res = await jiraFetch(`issue/${issueKey}?fields=${fields.join(",")}`, account);
  const issue = (await res.json()) as JiraIssue;
  const projectKey = issue.fields.project?.key ?? issueKey.split("-")[0];
  const projectId = getProjectId(account.id, projectKey);
  const storyPointFieldId = storyPointFieldMap[projectId] ?? DEFAULT_STORY_POINT_FIELD_ID;
  const task = mapIssueToTask(issue, account, projectKey, storyPointFieldId, currentUser);

  const workLogs = isWorklogTruncated(issue)
    ? (await fetchAllIssueWorklogs(account, issueKey)).map((wl) =>
        mapJiraWorklog(wl, task.id, currentUser),
      )
    : mapWorklogsFromIssue(issue, task.id, currentUser);

  return { task, workLogs };
}

function isWorklogTruncated(issue: JiraIssue): boolean {
  const wl = issue.fields.worklog;
  if (!wl) return false;
  return (wl.total ?? 0) > (wl.worklogs?.length ?? 0);
}

function isOwnJiraWorklog(wl: JiraWorklog, currentUser: JiraMyselfResponse | null): boolean | null {
  const authorId = wl.author?.accountId;
  if (!currentUser?.accountId || !authorId) return null;
  return authorId === currentUser.accountId;
}

function mapJiraWorklog(
  wl: JiraWorklog,
  taskId: string,
  currentUser: JiraMyselfResponse | null = null,
): WorkLog {
  return {
    id: `wl-jira-${wl.id}`,
    taskId,
    timeSpentMinutes: Math.round((wl.timeSpentSeconds ?? 0) / 60),
    logDate: wl.started.slice(0, 10),
    comment: wl.comment ? adfToText(wl.comment).trim() || null : null,
    createdAt: wl.started,
    jiraWorklogId: wl.id,
    syncStatus: "synced",
    authorName: wl.author?.displayName ?? null,
    isOwn: isOwnJiraWorklog(wl, currentUser),
  };
}

function mapWorklogsFromIssue(
  issue: JiraIssue,
  taskId: string,
  currentUser: JiraMyselfResponse | null,
): WorkLog[] {
  return (issue.fields.worklog?.worklogs ?? []).map((wl) =>
    mapJiraWorklog(wl, taskId, currentUser),
  );
}

async function fetchAllIssueWorklogs(
  account: JiraAccount,
  issueKey: string,
): Promise<JiraWorklog[]> {
  const all: JiraWorklog[] = [];
  const maxResults = 100;
  let startAt = 0;

  while (true) {
    const res = await jiraFetch(
      `issue/${issueKey}/worklog?startAt=${startAt}&maxResults=${maxResults}`,
      account,
    );
    const data = (await res.json()) as JiraWorklogListResponse;
    const page = data.worklogs ?? [];
    all.push(...page);
    const total = data.total ?? 0;
    startAt += page.length;
    if (startAt >= total || page.length === 0) break;
  }

  return all;
}

function resolveWorklogs(
  issueKey: string,
  taskId: string,
  issue: JiraIssue,
  worklogsByTaskId: Record<string, WorkLog[]>,
  truncatedIssueKeys: Map<string, string>,
  currentUser: JiraMyselfResponse | null,
): void {
  if (isWorklogTruncated(issue)) {
    truncatedIssueKeys.set(issueKey, taskId);
    return;
  }
  const worklogs = mapWorklogsFromIssue(issue, taskId, currentUser);
  if (worklogs.length > 0) worklogsByTaskId[taskId] = worklogs;
}

async function fetchTruncatedWorklogs(
  account: JiraAccount,
  truncatedIssueKeys: Map<string, string>,
  worklogsByTaskId: Record<string, WorkLog[]>,
  currentUser: JiraMyselfResponse | null,
): Promise<string[]> {
  const failedTaskIds: string[] = [];
  if (truncatedIssueKeys.size === 0) return failedTaskIds;
  await mapWithConcurrency(
    Array.from(truncatedIssueKeys.entries()),
    WORKLOG_FETCH_CONCURRENCY,
    async ([issueKey, taskId]) => {
      try {
        const allWorklogs = await fetchAllIssueWorklogs(account, issueKey);
        const mapped = allWorklogs.map((wl) => mapJiraWorklog(wl, taskId, currentUser));
        if (mapped.length > 0) worklogsByTaskId[taskId] = mapped;
      } catch (error: unknown) {
        console.warn(`Failed fetching full worklogs for ${issueKey}:`, error);
        failedTaskIds.push(taskId);
      }
    },
  );
  return failedTaskIds;
}

function mapPriorityToSeverity(priority: string | null | undefined): Task["severity"] {
  const lower = priority?.toLowerCase() ?? "";
  return SEVERITY_PATTERNS.find(([re]) => re.test(lower))?.[1] ?? "NA";
}

// Update issue fields in Jira
export async function updateJiraIssue(
  account: JiraAccount,
  issueKey: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await jiraFetch(`issue/${issueKey}`, account, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

/** Status names the issue can move to right now, according to its workflow. */
export async function fetchJiraTransitionTargets(
  account: JiraAccount,
  issueKey: string,
): Promise<string[]> {
  const res = await jiraFetch(`issue/${issueKey}/transitions`, account);
  const data = (await res.json()) as JiraTransitionsResponse;
  const names = (data.transitions ?? [])
    .map((transition) => transition.to?.name ?? transition.name ?? "")
    .filter(Boolean);
  return [...new Set(names)];
}

// Transition issue status
export async function transitionJiraIssue(
  account: JiraAccount,
  issueKey: string,
  statusName: string,
): Promise<void> {
  const res = await jiraFetch(`issue/${issueKey}/transitions`, account);
  const data = (await res.json()) as JiraTransitionsResponse;
  const transition = data.transitions?.find(
    (candidate) => candidate.name === statusName || candidate.to?.name === statusName,
  );
  if (!transition) throw new Error(`No transition found to status "${statusName}"`);

  await jiraFetch(`issue/${issueKey}/transitions`, account, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
}

// Add work log to Jira — returns the Jira worklog ID
export async function addJiraWorkLog(
  account: JiraAccount,
  issueKey: string,
  timeSpentMinutes: number,
  started: string,
  comment: string | null,
): Promise<string | null> {
  const res = await jiraFetch(`issue/${issueKey}/worklog`, account, {
    method: "POST",
    body: JSON.stringify({
      timeSpentSeconds: timeSpentMinutes * 60,
      started: new Date(started).toISOString().replace("Z", "+0000"),
      ...(comment
        ? {
            comment: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
            },
          }
        : {}),
    }),
  });
  const data = (await res.json()) as JiraCreatedWorklogResponse;
  return data.id ?? null;
}

// Add a plain-text comment to a Jira issue
export async function addJiraComment(
  account: JiraAccount,
  issueKey: string,
  text: string,
): Promise<void> {
  await jiraFetch(`issue/${issueKey}/comment`, account, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    }),
  });
}

// Delete a work log from Jira
export async function deleteJiraWorkLog(
  account: JiraAccount,
  issueKey: string,
  worklogId: string,
): Promise<void> {
  await jiraFetch(`issue/${issueKey}/worklog/${worklogId}`, account, { method: "DELETE" });
}
