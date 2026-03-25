import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAssignedJiraData } from "@/lib/jira-api";
import type { JiraAccount } from "@/lib/jira-db";

const httpFetchMock = vi.fn();

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => httpFetchMock(...args),
}));

vi.mock("@/lib/jira-db", () => ({
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
    json: vi.fn(async () => payload),
    text: vi.fn(async () => JSON.stringify(payload)),
  } as unknown as Response;
}

function buildSearchResponse(status: string) {
  return {
    issues: [
      {
        key: "ALPHA-1",
        fields: {
          summary: "Alpha task",
          description: null,
          status: { name: status },
          issuetype: { name: "Task" },
          priority: { name: "Medium" },
          assignee: { displayName: "Alice" },
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
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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
  });
});
