import { getJiraSettings, getJiraBaseUrl, type JiraSettings } from "./jira-db";
import type { Organization, Project, Task, WorkLog } from "@/types/jira";

function getAuthHeader(settings: JiraSettings): string {
  return "Basic " + btoa(`${settings.email}:${settings.apiToken}`);
}

async function jiraFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const settings = getJiraSettings();
  if (!settings) throw new Error("Jira not configured");

  const baseUrl = getJiraBaseUrl(settings);
  const url = `${baseUrl}/rest/api/3/${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: getAuthHeader(settings),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira API ${res.status}: ${text}`);
  }
  return res;
}

// Test connection
export async function testJiraConnection(): Promise<boolean> {
  try {
    await jiraFetch("myself");
    return true;
  } catch {
    return false;
  }
}

// Fetch all projects
export async function fetchJiraProjects(): Promise<Project[]> {
  const res = await jiraFetch("project?expand=description");
  const data = await res.json();
  const settings = getJiraSettings()!;
  const baseUrl = getJiraBaseUrl(settings);

  // Create a single org from the instance
  const orgId = `org-${baseUrl.replace(/[^a-z0-9]/gi, "")}`;

  return data.map((p: any) => ({
    id: `proj-${p.key}`,
    orgId,
    name: p.name,
    jiraProjectKey: p.key,
    availableStatuses: [], // will be populated from issues
  }));
}

// Fetch organization info
export async function fetchJiraOrganization(): Promise<Organization> {
  const settings = getJiraSettings()!;
  const baseUrl = getJiraBaseUrl(settings);
  const res = await jiraFetch("serverInfo");
  const data = await res.json();

  return {
    id: `org-${baseUrl.replace(/[^a-z0-9]/gi, "")}`,
    name: data.serverTitle ?? data.baseUrl ?? baseUrl,
    jiraInstanceUrl: baseUrl,
    lastSyncedAt: new Date().toISOString(),
  };
}

// Fetch issues for a project
export async function fetchJiraIssues(projectKey: string, startAt = 0): Promise<{ tasks: Task[]; total: number; statuses: string[] }> {
  const settings = getJiraSettings()!;
  const baseUrl = getJiraBaseUrl(settings);
  const orgId = `org-${baseUrl.replace(/[^a-z0-9]/gi, "")}`;

  const jql = encodeURIComponent(`project = ${projectKey} ORDER BY updated DESC`);
  const fields = "summary,status,issuetype,priority,assignee,description,created,updated,customfield_10016";
  const res = await jiraFetch(`search?jql=${jql}&fields=${fields}&startAt=${startAt}&maxResults=100`);
  const data = await res.json();

  const statusSet = new Set<string>();
  const tasks: Task[] = data.issues.map((issue: any) => {
    const status = issue.fields.status?.name ?? null;
    if (status) statusSet.add(status);

    const issueType = issue.fields.issuetype?.name ?? null;
    let type: Task["type"] = null;
    if (issueType === "Bug") type = "Bug";
    else if (issueType === "Story") type = "Story";
    else if (issueType) type = "Task";

    return {
      id: `task-${issue.key}`,
      projectId: `proj-${projectKey}`,
      jiraTaskId: issue.key,
      title: issue.fields.summary ?? "",
      description: issue.fields.description
        ? typeof issue.fields.description === "string"
          ? issue.fields.description
          : JSON.stringify(issue.fields.description)
        : null,
      status,
      type,
      severity: mapPriorityToSeverity(issue.fields.priority?.name),
      storyLevel: issue.fields.customfield_10016 ?? null,
      mandays: null,
      assignee: issue.fields.assignee?.displayName ?? null,
      refUrl: `${baseUrl}/browse/${issue.key}`,
      note: null,
      isSynced: true,
      isDirty: false,
      createdAt: issue.fields.created,
      updatedAt: issue.fields.updated,
    };
  });

  return { tasks, total: data.total, statuses: Array.from(statusSet) };
}

function mapPriorityToSeverity(priority: string | undefined): Task["severity"] {
  if (!priority) return "NA";
  const lower = priority.toLowerCase();
  if (lower.includes("critical") || lower.includes("highest") || lower.includes("blocker")) return "Critical";
  if (lower.includes("high")) return "High";
  if (lower.includes("medium") || lower.includes("normal")) return "Medium";
  if (lower.includes("low") || lower.includes("lowest")) return "Low";
  return "NA";
}

// Update issue fields in Jira
export async function updateJiraIssue(issueKey: string, fields: Record<string, any>): Promise<void> {
  await jiraFetch(`issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

// Transition issue status
export async function transitionJiraIssue(issueKey: string, statusName: string): Promise<void> {
  // First get available transitions
  const res = await jiraFetch(`issue/${issueKey}/transitions`);
  const data = await res.json();
  const transition = data.transitions?.find((t: any) => t.name === statusName || t.to?.name === statusName);
  if (!transition) throw new Error(`No transition found to status "${statusName}"`);

  await jiraFetch(`issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
}

// Add work log to Jira
export async function addJiraWorkLog(issueKey: string, timeSpentMinutes: number, started: string, comment: string | null): Promise<void> {
  await jiraFetch(`issue/${issueKey}/worklog`, {
    method: "POST",
    body: JSON.stringify({
      timeSpentSeconds: timeSpentMinutes * 60,
      started: new Date(started).toISOString().replace("Z", "+0000"),
      ...(comment ? { comment: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] } } : {}),
    }),
  });
}
