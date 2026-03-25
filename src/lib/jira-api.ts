import { getJiraBaseUrl, getStoryPointFieldMap, type JiraAccount } from "./jira-db";
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

type JiraIssueLinkEntry = {
  inwardIssue?: { key: string } | null;
  outwardIssue?: { key: string } | null;
};

type JiraIssueFields = {
  summary?: string | null;
  description?: JiraTextContent;
  status?: JiraNamedField | null;
  issuetype?: JiraNamedField | null;
  priority?: JiraNamedField | null;
  assignee?: JiraAssignee | null;
  customfield_10016?: number | null;
  [key: string]: unknown; // allow dynamic custom fields (e.g. story point overrides)
  timetracking?: {
    originalEstimateSeconds?: number | null;
  } | null;
  project?: JiraProjectField | null;
  created: string;
  updated: string;
  worklog?: {
    worklogs?: JiraWorklog[];
  } | null;
  issuelinks?: JiraIssueLinkEntry[] | null;
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

type JiraProjectStatus = {
  name?: string | null;
};

type JiraProjectIssueTypeStatuses = {
  statuses?: JiraProjectStatus[] | null;
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

function mapIssueToTask(
  issue: JiraIssue,
  account: JiraAccount,
  projectKey: string,
  storyPointFieldId = "customfield_10016",
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

  const issueType = issue.fields.issuetype?.name ?? undefined;
  const type: Task["type"] = issueType ? (ISSUE_TYPE_MAP[issueType] ?? "Task") : null;

  return {
    id: getTaskId(account.id, issue.key),
    projectId: getProjectId(account.id, projectKey),
    jiraTaskId: issue.key,
    title: issue.fields.summary ?? "",
    description,
    status: issue.fields.status?.name ?? null,
    type,
    severity: mapPriorityToSeverity(issue.fields.priority?.name),
    storyLevel: normalizeStoryLevel(issue.fields[storyPointFieldId] as number | null | undefined),
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

async function fetchProjectStatuses(account: JiraAccount, projectKey: string): Promise<string[]> {
  const res = await jiraFetch(`project/${encodeURIComponent(projectKey)}/statuses`, account);
  const data = (await res.json()) as JiraProjectIssueTypeStatuses[];

  return mergeStatuses(
    (data ?? []).flatMap((issueType) =>
      (issueType.statuses ?? []).map((status) => status.name ?? "").filter(Boolean),
    ),
    [],
  );
}

// Fetch issues for a project using the new /search/jql endpoint
export async function fetchJiraIssues(
  account: JiraAccount,
  projectKey: string,
): Promise<{ tasks: Task[]; statuses: string[]; worklogsByTaskId: Record<string, WorkLog[]> }> {
  const projectId = getProjectId(account.id, projectKey);
  const storyPointFieldMap = getStoryPointFieldMap();
  const storyPointFieldId = storyPointFieldMap[projectId] ?? "customfield_10016";

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
    storyPointFieldId,
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
      const task = mapIssueToTask(issue, account, projectKey, storyPointFieldId);
      allTasks.push(task);
      const wls = mapWorklogsFromIssue(issue, task.id);
      if (wls.length > 0) worklogsByTaskId[task.id] = wls;
    }

    if (data.isLast) break;
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  const projectStatuses = await fetchProjectStatuses(account, projectKey).catch(
    (error: unknown) => {
      console.warn(`Failed fetching statuses for project ${projectKey}:`, error);
      return [];
    },
  );

  return {
    tasks: allTasks,
    statuses: mergeStatuses(projectStatuses, statusSet),
    worklogsByTaskId,
  };
}

export async function fetchAssignedJiraData(account: JiraAccount): Promise<AssignedJiraData> {
  const storyPointFieldMap = getStoryPointFieldMap();
  // Collect all unique story-point field IDs configured for this account's projects.
  const storyPointFieldIds = new Set(["customfield_10016"]);
  for (const fieldId of Object.values(storyPointFieldMap)) {
    if (fieldId) storyPointFieldIds.add(fieldId);
  }

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
    ...storyPointFieldIds,
    "parent",
    "worklog",
    "timetracking",
    "project",
    "issuelinks",
  ];

  const projectMap = new Map<string, Project>();
  const statusSetByProjectId = new Map<string, Set<string>>();
  const tasks: Task[] = [];
  const worklogsByTaskId: Record<string, WorkLog[]> = {};
  const fetchedKeys = new Set<string>();
  const linkedKeys = new Set<string>();
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

      fetchedKeys.add(issue.key);

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

      const projectStoryPointFieldId = storyPointFieldMap[projectId] ?? "customfield_10016";
      const task = mapIssueToTask(issue, account, projectKey, projectStoryPointFieldId);
      tasks.push(task);

      const worklogs = mapWorklogsFromIssue(issue, task.id);
      if (worklogs.length > 0) {
        worklogsByTaskId[task.id] = worklogs;
      }

      // Collect linked issue keys for a follow-up fetch
      for (const link of issue.fields.issuelinks ?? []) {
        const key = link.inwardIssue?.key ?? link.outwardIssue?.key;
        if (key) linkedKeys.add(key);
      }
    }

    if (data.isLast) break;
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  // Fetch linked issues that weren't already returned by the main query
  const unfetchedLinkedKeys = Array.from(linkedKeys).filter((k) => !fetchedKeys.has(k));
  if (unfetchedLinkedKeys.length > 0) {
    const BATCH = 50;
    for (let i = 0; i < unfetchedLinkedKeys.length; i += BATCH) {
      const batch = unfetchedLinkedKeys.slice(i, i + BATCH);
      const linkedJql = `issueKey in (${batch.map((k) => `"${k}"`).join(",")})`;
      const body: Record<string, unknown> = { jql: linkedJql, maxResults: BATCH, fields };

      try {
        const res = await jiraFetch("search/jql", account, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as JiraSearchResponse;

        for (const issue of data.issues ?? []) {
          if (fetchedKeys.has(issue.key)) continue;
          fetchedKeys.add(issue.key);

          const projectKey = issue.fields.project?.key;
          if (!projectKey) continue;

          const projectId = getProjectId(account.id, projectKey);
          if (!projectMap.has(projectKey)) {
            projectMap.set(projectKey, {
              id: projectId,
              orgId: getOrganizationId(account.id),
              name: issue.fields.project?.name ?? projectKey,
              jiraProjectKey: projectKey,
              availableStatuses: [],
            } satisfies Project);
          }

          const status = issue.fields.status?.name ?? null;
          if (status) {
            const projectStatuses = statusSetByProjectId.get(projectId) ?? new Set<string>();
            projectStatuses.add(status);
            statusSetByProjectId.set(projectId, projectStatuses);
          }

          const linkedProjectId = getProjectId(account.id, projectKey);
          const linkedStoryPointFieldId =
            storyPointFieldMap[linkedProjectId] ?? "customfield_10016";
          const task = mapIssueToTask(issue, account, projectKey, linkedStoryPointFieldId);
          tasks.push(task);

          const worklogs = mapWorklogsFromIssue(issue, task.id);
          if (worklogs.length > 0) {
            worklogsByTaskId[task.id] = worklogs;
          }
        }
      } catch {
        // Linked issues batch failed (e.g. permission denied) — skip silently
      }
    }
  }

  const collectedProjects = Array.from(projectMap.values());
  const projectStatusResults = await Promise.allSettled(
    collectedProjects.map((project) => fetchProjectStatuses(account, project.jiraProjectKey)),
  );

  const projects = collectedProjects.map((project, index) => {
    const statusResult = projectStatusResults[index];
    if (statusResult.status === "rejected") {
      console.warn(
        `Failed fetching statuses for project ${project.jiraProjectKey}:`,
        statusResult.reason,
      );
    }

    return {
      ...project,
      availableStatuses: mergeStatuses(
        statusResult.status === "fulfilled" ? statusResult.value : [],
        statusSetByProjectId.get(project.id) ?? [],
      ),
    };
  });

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
    syncStatus: "synced",
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
