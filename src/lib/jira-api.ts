import { getJiraBaseUrl, type JiraAccount } from "./jira-db";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";
import { fetch } from "@tauri-apps/plugin-http";
import { getOrganizationId, getProjectId, getTaskId } from "@/lib/jira-ids";

const ISSUE_TYPE_MAP: Partial<Record<string, Task["type"]>> = {
  Bug: "Bug",
  Story: "Story",
};

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

type JiraAssignee = {
  displayName?: string | null;
};

type JiraProjectField = {
  key?: string | null;
  name?: string | null;
};

type JiraWorklog = {
  id: string;
  timeSpentSeconds?: number | null;
  started: string;
  comment?: JiraTextContent;
};

type JiraIssueFields = {
  summary?: string | null;
  description?: JiraTextContent;
  status?: JiraNamedField | null;
  issuetype?: JiraNamedField | null;
  priority?: JiraNamedField | null;
  assignee?: JiraAssignee | null;
  customfield_10016?: number | null;
  timetracking?: {
    originalEstimateSeconds?: number | null;
  } | null;
  project?: JiraProjectField | null;
  created: string;
  updated: string;
  worklog?: {
    worklogs?: JiraWorklog[];
  } | null;
};

type JiraIssue = {
  key: string;
  fields: JiraIssueFields;
};

type JiraProjectSearchResponse = {
  values?: Array<{
    key: string;
    name: string;
  }>;
  isLast?: boolean;
};

type JiraMyselfResponse = {
  displayName?: string | null;
};

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

type AssignedJiraData = {
  projects: Project[];
  tasks: Task[];
  worklogsByTaskId: Record<string, WorkLog[]>;
};

function getAuthHeader(account: JiraAccount): string {
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

  const res = await fetch(url, {
    ...options,
    credentials: "omit",
    headers,
  });
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

function mapIssueToTask(issue: JiraIssue, account: JiraAccount, projectKey: string): Task {
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

  const issueType = issue.fields.issuetype?.name ?? undefined;
  const type: Task["type"] = issueType ? ISSUE_TYPE_MAP[issueType] ?? "Task" : null;

  return {
    id: getTaskId(account.id, issue.key),
    projectId: getProjectId(account.id, projectKey),
    jiraTaskId: issue.key,
    title: issue.fields.summary ?? "",
    description,
    status: issue.fields.status?.name ?? null,
    type,
    severity: mapPriorityToSeverity(issue.fields.priority?.name),
    storyLevel: normalizeStoryLevel(issue.fields.customfield_10016),
    mandays:
      issue.fields.timetracking?.originalEstimateSeconds != null
        ? Math.round((issue.fields.timetracking.originalEstimateSeconds / 28800) * 1000) / 1000
        : null,
    assignee: issue.fields.assignee?.displayName ?? null,
    refUrl: `${getJiraBaseUrl(account)}/browse/${issue.key}`,
    note: null,
    isSynced: true,
    isDirty: false,
    createdAt: issue.fields.created,
    updatedAt: issue.fields.updated,
  };
}

// Fetch issues for a project using the new /search/jql endpoint
export async function fetchJiraIssues(
  account: JiraAccount,
  projectKey: string,
): Promise<{ tasks: Task[]; statuses: string[]; worklogsByTaskId: Record<string, WorkLog[]> }> {
  const jql = `project = "${projectKey}" AND (assignee = currentUser() OR assignee was currentUser()) ORDER BY updated DESC`;
  const fields = [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "description",
    "created",
    "updated",
    "customfield_10016",
    "parent",
    "worklog",
    "timetracking",
  ];

  const allTasks: Task[] = [];
  const statusSet = new Set<string>();
  const worklogsByTaskId: Record<string, WorkLog[]> = {};
  let nextPageToken: string | undefined;

  while (true) {
    const body: Record<string, unknown> = { jql, maxResults: 100, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await jiraFetch("search/jql", account, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as JiraSearchResponse;

    for (const issue of data.issues ?? []) {
      const status = issue.fields.status?.name ?? null;
      if (status) statusSet.add(status);
      const task = mapIssueToTask(issue, account, projectKey);
      allTasks.push(task);
      const wls = mapWorklogsFromIssue(issue, task.id);
      if (wls.length > 0) worklogsByTaskId[task.id] = wls;
    }

    if (data.isLast) break;
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  return { tasks: allTasks, statuses: Array.from(statusSet), worklogsByTaskId };
}

export async function fetchAssignedJiraData(account: JiraAccount): Promise<AssignedJiraData> {
  const jql = `(assignee = currentUser() OR assignee was currentUser()) ORDER BY updated DESC`;
  const fields = [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "description",
    "created",
    "updated",
    "customfield_10016",
    "parent",
    "worklog",
    "timetracking",
    "project",
  ];

  const projectMap = new Map<string, Project>();
  const statusSetByProjectId = new Map<string, Set<string>>();
  const tasks: Task[] = [];
  const worklogsByTaskId: Record<string, WorkLog[]> = {};
  let nextPageToken: string | undefined;

  while (true) {
    const body: Record<string, unknown> = { jql, maxResults: 100, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await jiraFetch("search/jql", account, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as JiraSearchResponse;

    for (const issue of data.issues ?? []) {
      const projectKey = issue.fields.project?.key;
      if (!projectKey) continue;

      const projectId = getProjectId(account.id, projectKey);
      const project =
        projectMap.get(projectKey) ??
        ({
          id: projectId,
          orgId: getOrganizationId(account.id),
          name: issue.fields.project?.name ?? projectKey,
          jiraProjectKey: projectKey,
          availableStatuses: [],
        } satisfies Project);

      if (!projectMap.has(projectKey)) {
        projectMap.set(projectKey, project);
      }

      const status = issue.fields.status?.name ?? null;
      if (status) {
        const projectStatuses = statusSetByProjectId.get(projectId) ?? new Set<string>();
        projectStatuses.add(status);
        statusSetByProjectId.set(projectId, projectStatuses);
      }

      const task = mapIssueToTask(issue, account, projectKey);
      tasks.push(task);

      const worklogs = mapWorklogsFromIssue(issue, task.id);
      if (worklogs.length > 0) {
        worklogsByTaskId[task.id] = worklogs;
      }
    }

    if (data.isLast) break;
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  const projects = Array.from(projectMap.values()).map((project) => ({
    ...project,
    availableStatuses: Array.from(statusSetByProjectId.get(project.id) ?? []),
  }));

  return { projects, tasks, worklogsByTaskId };
}

function mapWorklogsFromIssue(issue: JiraIssue, taskId: string): WorkLog[] {
  const worklogs = issue.fields.worklog?.worklogs ?? [];
  return worklogs.map((wl) => ({
    id: `wl-jira-${wl.id}`,
    taskId,
    timeSpentMinutes: Math.round((wl.timeSpentSeconds ?? 0) / 60),
    logDate: wl.started.slice(0, 10),
    comment: wl.comment ? adfToText(wl.comment).trim() || null : null,
    createdAt: wl.started,
    jiraWorklogId: wl.id,
  }));
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

// Delete a work log from Jira
export async function deleteJiraWorkLog(
  account: JiraAccount,
  issueKey: string,
  worklogId: string,
): Promise<void> {
  await jiraFetch(`issue/${issueKey}/worklog/${worklogId}`, account, { method: "DELETE" });
}
