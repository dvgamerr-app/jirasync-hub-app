import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { fetchAssignedJiraData } from "@/lib/jira-api";
import type { JiraAccount } from "@/lib/jira-db";

const httpFetchMock = mock();

mock.module("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => httpFetchMock(...args),
}));

mock.module("@/lib/jira-db", () => ({
  getJiraBaseUrl: (account: { instanceUrl: string }) => account.instanceUrl,
  getStoryPointFieldMap: () => ({}),
}));

const account: JiraAccount = {
  id: "acc-1",
  name: "Acme",
  instanceUrl: "https://acme.atlassian.net",
  email: "alice@example.com",
  apiToken: "secret",
};

function mockJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: mock(async () => payload),
    text: mock(async () => JSON.stringify(payload)),
  } as unknown as Response;
}

function buildSearchResponse(
  status: string,
  options: { statusCategoryKey?: string; assigneeDisplayName?: string | null } = {},
) {
  return {
    issues: [
      {
        key: "ALPHA-1",
        fields: {
          summary: "Alpha task",
          description: null,
          status: {
            name: status,
            statusCategory: options.statusCategoryKey ? { key: options.statusCategoryKey } : undefined,
          },
          issuetype: { name: "Task" },
          priority: { name: "Medium" },
          assignee:
            options.assigneeDisplayName === undefined
              ? { displayName: "Alice" }
              : options.assigneeDisplayName === null
                ? null
                : { displayName: options.assigneeDisplayName },
          customfield_10016: null,
          timetracking: null,
          project: { key: "ALPHA", name: "Project Alpha" },
          created: "2026-03-20T10:00:00.000Z",
          updated: "2026-03-21T10:00:00.000Z",
          worklog: { worklogs: [] },
          issuelinks: [],
        },
      },
    ],
    isLast: true,
  };
}

describe("fetchAssignedJiraData", () => {
  beforeEach(() => {
    httpFetchMock.mockReset();
  });

  it("stores the full project status catalog during sync", async () => {
    httpFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/rest/api/3/search/jql")) {
        return mockJsonResponse(buildSearchResponse("In Progress"));
      }

      if (url.endsWith("/rest/api/3/project/ALPHA/statuses")) {
        return mockJsonResponse([
          { statuses: [{ name: "To Do" }, { name: "In Progress" }] },
          { statuses: [{ name: "Done" }, { name: "In Progress" }] },
        ]);
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchAssignedJiraData(account);

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].availableStatuses).toEqual(["To Do", "In Progress", "Done"]);
  });

  it("falls back to issue-derived statuses if project status lookup fails", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    httpFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/rest/api/3/search/jql")) {
        return mockJsonResponse(buildSearchResponse("QA"));
      }

      if (url.endsWith("/rest/api/3/project/ALPHA/statuses")) {
        throw new Error("status lookup failed");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchAssignedJiraData(account);

    expect(result.projects[0].availableStatuses).toEqual(["QA"]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("maps statusCategory and flags whether the issue is still assigned to us", async () => {
    httpFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/rest/api/3/myself")) {
        return mockJsonResponse({ displayName: "Alice" });
      }

      if (url.endsWith("/rest/api/3/search/jql")) {
        return mockJsonResponse(
          buildSearchResponse("To Do", { statusCategoryKey: "new", assigneeDisplayName: "Bob" }),
        );
      }

      if (url.endsWith("/rest/api/3/project/ALPHA/statuses")) {
        return mockJsonResponse([{ statuses: [{ name: "To Do" }] }]);
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchAssignedJiraData(account);
    const task = result.tasks[0];

    expect(task.statusCategory).toBe("new");
    expect(task.assignee).toBe("Bob");
    expect(task.isCurrentAssignee).toBe(false);
  });

  it("marks isCurrentAssignee true when the issue is still assigned to us", async () => {
    httpFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/rest/api/3/myself")) {
        return mockJsonResponse({ displayName: "Alice" });
      }

      if (url.endsWith("/rest/api/3/search/jql")) {
        return mockJsonResponse(
          buildSearchResponse("In Progress", {
            statusCategoryKey: "indeterminate",
            assigneeDisplayName: "Alice",
          }),
        );
      }

      if (url.endsWith("/rest/api/3/project/ALPHA/statuses")) {
        return mockJsonResponse([{ statuses: [{ name: "In Progress" }] }]);
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchAssignedJiraData(account);
    const task = result.tasks[0];

    expect(task.statusCategory).toBe("indeterminate");
    expect(task.isCurrentAssignee).toBe(true);
  });
});
