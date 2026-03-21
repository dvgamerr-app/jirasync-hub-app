import { getJiraBaseUrl, type JiraAccount } from "./jira-db";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";
import { fetch } from "@tauri-apps/plugin-http";

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

function getAuthHeader(account: JiraAccount): string {
  return "Basic " + btoa(`${account.email}:${account.apiToken}`);
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
    "Content-Type": "application/json",
    Accept: "application/json",
  };

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
  const data = await res.json();
  return data.displayName ?? account.name ?? account.email;
}

// Fetch all projects (paginated)
export async function fetchJiraProjects(account: JiraAccount): Promise<Project[]> {
  const orgId = `org-${account.id}`;
  const projects: Project[] = [];
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const res = await jiraFetch(
      `project/search?maxResults=${maxResults}&startAt=${startAt}&expand=description`,
      account,
    );
    const data = await res.json();

    for (const p of data.values ?? []) {
      projects.push({
        id: `proj-${account.id}-${p.key}`,
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
  const data = await res.json();

  return {
    id: `org-${account.id}`,
    name: account.name || data.serverTitle || data.baseUrl || baseUrl,
    jiraInstanceUrl: baseUrl,
    lastSyncedAt: new Date().toISOString(),
  };
}

// Extract plain text from Atlassian Document Format (ADF)
function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (Array.isArray(node.content)) {
    const sep = node.type === "paragraph" || node.type === "heading" ? "\n" : "";
    return node.content.map(adfToText).join("") + sep;
  }
  return "";
}

function mapIssueToTask(issue: any, account: JiraAccount, projectKey: string): Task {
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

  const issueType = issue.fields.issuetype?.name as string | undefined;
  const type: Task["type"] = ISSUE_TYPE_MAP[issueType!] ?? (issueType ? "Task" : null);

  return {
    id: `task-${account.id}-${issue.key}`,
    projectId: `proj-${account.id}-${projectKey}`,
    jiraTaskId: issue.key,
    title: issue.fields.summary ?? "",
    description,
    status: issue.fields.status?.name ?? null,
    type,
    severity: mapPriorityToSeverity(issue.fields.priority?.name),
    storyLevel: issue.fields.customfield_10016 ?? null,
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
    const data = await res.json();

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

function mapWorklogsFromIssue(issue: any, taskId: string): WorkLog[] {
  const worklogs: any[] = issue.fields.worklog?.worklogs ?? [];
  return worklogs.map((wl: any) => ({
    id: `wl-jira-${wl.id}`,
    taskId,
    timeSpentMinutes: Math.round((wl.timeSpentSeconds ?? 0) / 60),
    logDate: (wl.started as string).slice(0, 10),
    comment: wl.comment ? adfToText(wl.comment).trim() || null : null,
    createdAt: wl.started,
    jiraWorklogId: wl.id,
  }));
}

function mapPriorityToSeverity(priority: string | undefined): Task["severity"] {
  const lower = priority?.toLowerCase() ?? "";
  return SEVERITY_PATTERNS.find(([re]) => re.test(lower))?.[1] ?? "NA";
}

// Update issue fields in Jira
export async function updateJiraIssue(
  account: JiraAccount,
  issueKey: string,
  fields: Record<string, any>,
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
  const data = await res.json();
  const transition = data.transitions?.find(
    (t: any) => t.name === statusName || t.to?.name === statusName,
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
  const data = await res.json();
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
