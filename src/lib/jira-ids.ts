import type { Task } from "@/types/jira";

const ORGANIZATION_ID_PREFIX = "org";
const PROJECT_ID_PREFIX = "proj";
const TASK_ID_PREFIX = "task";

function buildScopedId(prefix: string, accountId: string, suffix?: string): string {
  return suffix ? `${prefix}-${accountId}-${suffix}` : `${prefix}-${accountId}`;
}

export function getOrganizationId(accountId: string): string {
  return buildScopedId(ORGANIZATION_ID_PREFIX, accountId);
}

export function getProjectId(accountId: string, projectKey: string): string {
  return buildScopedId(PROJECT_ID_PREFIX, accountId, projectKey);
}

export function getProjectIdPrefix(accountId: string): string {
  return `${PROJECT_ID_PREFIX}-${accountId}-`;
}

export function getTaskId(accountId: string, issueKey: string): string {
  return buildScopedId(TASK_ID_PREFIX, accountId, issueKey);
}

export function getTaskIdPrefix(accountId: string): string {
  return `${TASK_ID_PREFIX}-${accountId}-`;
}

export function getAccountIdFromTask(task: Pick<Task, "id" | "jiraTaskId">): string | null {
  const taskPrefix = `${TASK_ID_PREFIX}-`;
  const taskSuffix = `-${task.jiraTaskId}`;

  if (!task.id.startsWith(taskPrefix) || !task.id.endsWith(taskSuffix)) {
    return null;
  }

  const accountId = task.id.slice(taskPrefix.length, task.id.length - taskSuffix.length);
  return accountId || null;
}

export function isOrganizationIdForAccounts(orgId: string, accountIds: string[]): boolean {
  return accountIds.some((accountId) => orgId === getOrganizationId(accountId));
}

export function isProjectIdForAccounts(projectId: string, accountIds: string[]): boolean {
  return accountIds.some((accountId) => projectId.startsWith(getProjectIdPrefix(accountId)));
}

export function isTaskIdForAccounts(taskId: string, accountIds: string[]): boolean {
  return accountIds.some((accountId) => taskId.startsWith(getTaskIdPrefix(accountId)));
}
