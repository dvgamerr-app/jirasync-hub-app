import type { Page, Route } from "@playwright/test";

export const ME = { accountId: "acc-me", displayName: "Me Tester" };
export const OTHER = { accountId: "acc-other", displayName: "Other Person" };

type JiraUser = { accountId: string; displayName: string };

export interface FakeWorklog {
  id: string;
  author: JiraUser;
  /** ISO date-time, e.g. 2026-03-10T09:00:00.000+0000 */
  started: string;
  timeSpentSeconds: number;
  comment?: string | null;
}

export interface FakeIssue {
  key: string;
  summary: string;
  status: string;
  issuetype: string;
  priority: string;
  project: { key: string; name: string };
  assignee: JiraUser | null;
  creator: JiraUser;
  storyPoints: number | null;
  originalEstimateSeconds: number | null;
  /** ADF document, or null */
  description: unknown;
  parent: string | null;
  created: string;
  updated: string;
  worklogs: FakeWorklog[];
  /** Statuses this issue can NOT transition to (simulates workflow restrictions). */
  blockedStatuses: string[];
  /** When false, the issue is not returned by the main "my work" JQL. */
  inMainQuery: boolean;
}

export type IssueInit = Partial<FakeIssue> & { key: string };

export interface RecordedRequest {
  method: string;
  /** Path after /rest/api/3/, without query string */
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** ms since the fake server was created, taken when the request arrived */
  startedAt: number;
  /** ms since the fake server was created, taken when the response was sent */
  endedAt?: number;
}

type Matcher = (req: RecordedRequest) => boolean;

interface Rule {
  match: Matcher;
  status?: number;
  body?: unknown;
  delayMs?: number;
  /** How many matching requests this rule applies to; Infinity by default. */
  remaining: number;
}

const STATUS_CATEGORY: Record<string, "new" | "indeterminate" | "done"> = {
  "To Do": "new",
  "In Progress": "indeterminate",
  "In Review": "indeterminate",
  Done: "done",
  Resolved: "done",
  Closed: "done",
};

export const DEFAULT_STATUSES = ["To Do", "In Progress", "In Review", "Done", "Resolved"];
const INLINE_WORKLOG_LIMIT = 20;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, accept",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export function adfParagraph(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export class FakeJira {
  readonly host: string;
  readonly baseUrl: string;
  readonly issues = new Map<string, FakeIssue>();
  readonly requests: RecordedRequest[] = [];
  statuses = DEFAULT_STATUSES;
  me: JiraUser = ME;
  private rules: Rule[] = [];
  private nextWorklogId = 9000;
  private readonly t0 = Date.now();
  private trackers: { name: string; pattern: RegExp; current: number; max: number }[] = [];

  /** Record the peak number of simultaneous in-flight requests whose path matches `pattern`. */
  track(name: string, pattern: RegExp) {
    this.trackers.push({ name, pattern, current: 0, max: 0 });
  }

  peakConcurrency(name: string): number {
    return this.trackers.find((t) => t.name === name)?.max ?? 0;
  }

  constructor(host = "acme.atlassian.net") {
    this.host = host;
    this.baseUrl = `https://${host}`;
  }

  // ── Seeding ────────────────────────────────────────────────────────────────

  addIssue(init: IssueInit): FakeIssue {
    const key = init.key;
    const projectKey = init.project?.key ?? key.split("-")[0];
    const issue: FakeIssue = {
      summary: `Summary of ${key}`,
      status: "To Do",
      issuetype: "Task",
      priority: "Medium",
      project: { key: projectKey, name: `Project ${projectKey}` },
      assignee: this.me,
      creator: this.me,
      storyPoints: null,
      originalEstimateSeconds: null,
      description: null,
      parent: null,
      created: "2026-03-01T08:00:00.000+0000",
      updated: "2026-03-01T08:00:00.000+0000",
      worklogs: [],
      blockedStatuses: [],
      inMainQuery: true,
      ...init,
    };
    this.issues.set(key, issue);
    return issue;
  }

  addWorklog(
    key: string,
    wl: Partial<FakeWorklog> & { timeSpentSeconds: number; started: string },
  ): FakeWorklog {
    const issue = this.mustGet(key);
    const worklog: FakeWorklog = {
      id: String(this.nextWorklogId++),
      author: this.me,
      ...wl,
    };
    issue.worklogs.push(worklog);
    return worklog;
  }

  // ── Fault injection ────────────────────────────────────────────────────────

  /** Respond to matching requests with an error status. */
  fail(
    match: Matcher,
    status = 500,
    body: unknown = { errorMessages: ["injected failure"] },
    times = Infinity,
  ) {
    this.rules.push({ match, status, body, remaining: times });
  }

  /** Hold matching requests for `ms` before answering. */
  delay(match: Matcher, ms: number, times = Infinity) {
    this.rules.push({ match, delayMs: ms, remaining: times });
  }

  clearRules() {
    this.rules = [];
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  find(method: string, pathPattern: RegExp | string): RecordedRequest[] {
    return this.requests.filter(
      (r) =>
        r.method === method &&
        (typeof pathPattern === "string" ? r.path === pathPattern : pathPattern.test(r.path)),
    );
  }

  /** PUT issue/{key} bodies recorded for `key` (the `fields` object only). */
  putFields(key: string): Record<string, unknown>[] {
    return this.find("PUT", `issue/${key}`).map(
      (r) => (r.body as { fields: Record<string, unknown> }).fields,
    );
  }

  clearRequests() {
    this.requests.length = 0;
  }

  mustGet(key: string): FakeIssue {
    const issue = this.issues.get(key);
    if (!issue) throw new Error(`FakeJira: no issue ${key}`);
    return issue;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  async attach(page: Page) {
    await page.route(`${this.baseUrl}/rest/api/3/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname.replace("/rest/api/3/", ""));
    let body: unknown = null;
    const raw = request.postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const rec: RecordedRequest = {
      method: request.method(),
      path,
      query: url.searchParams,
      body,
      startedAt: Date.now() - this.t0,
    };
    this.requests.push(rec);

    const active = this.trackers.filter((t) => t.pattern.test(path));
    for (const t of active) {
      t.current += 1;
      t.max = Math.max(t.max, t.current);
    }

    try {
      const rule = this.rules.find((r) => r.remaining > 0 && r.match(rec));
      if (rule) {
        rule.remaining -= 1;
        if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
        if (rule.status !== undefined) {
          rec.endedAt = Date.now() - this.t0;
          await route.fulfill({
            status: rule.status,
            headers: { ...CORS_HEADERS, "content-type": "application/json" },
            body: JSON.stringify(rule.body ?? {}),
          });
          return;
        }
      }

      const result = this.dispatch(rec);
      rec.endedAt = Date.now() - this.t0;
      await route.fulfill({
        status: result.status,
        headers: { ...CORS_HEADERS, "content-type": "application/json" },
        body: result.body === undefined ? undefined : JSON.stringify(result.body),
      });
    } finally {
      for (const t of active) t.current -= 1;
    }
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private dispatch(req: RecordedRequest): { status: number; body?: unknown } {
    const { method, path } = req;

    if (method === "GET" && path === "myself") {
      return { status: 200, body: { ...this.me, emailAddress: "me@acme.test" } };
    }
    if (method === "GET" && path === "serverInfo") {
      return { status: 200, body: { serverTitle: "Acme Jira", baseUrl: this.baseUrl } };
    }
    if (method === "GET" && path === "field") {
      return {
        status: 200,
        body: [
          {
            id: "customfield_10016",
            name: "Story Points",
            custom: true,
            schema: { type: "number" },
          },
        ],
      };
    }
    if (method === "POST" && path === "search/jql") return this.search(req);

    let m = path.match(/^project\/([^/]+)\/statuses$/);
    if (method === "GET" && m) {
      const issueTypes = new Set(
        [...this.issues.values()].filter((i) => i.project.key === m![1]).map((i) => i.issuetype),
      );
      return {
        status: 200,
        body: [...(issueTypes.size ? issueTypes : ["Task"])].map((name) => ({
          name,
          statuses: this.statuses.map((s) => ({ name: s })),
        })),
      };
    }

    m = path.match(/^issue\/([^/]+)\/transitions$/);
    if (m) {
      const issue = this.issues.get(m[1]);
      if (!issue) return { status: 404, body: { errorMessages: ["not found"] } };
      if (method === "GET") {
        return {
          status: 200,
          body: {
            transitions: this.statuses
              .filter((s) => s !== issue.status && !issue.blockedStatuses.includes(s))
              .map((s, i) => ({ id: String(i + 1), name: s, to: { name: s } })),
          },
        };
      }
      if (method === "POST") {
        const id = (req.body as { transition: { id: string } }).transition.id;
        const target = this.statuses.filter(
          (s) => s !== issue.status && !issue.blockedStatuses.includes(s),
        )[Number(id) - 1];
        if (!target) return { status: 400, body: { errorMessages: ["bad transition"] } };
        issue.status = target;
        issue.updated = new Date().toISOString();
        return { status: 204 };
      }
    }

    m = path.match(/^issue\/([^/]+)\/worklog\/([^/]+)$/);
    if (method === "DELETE" && m) {
      const issue = this.issues.get(m[1]);
      if (!issue) return { status: 404, body: { errorMessages: ["not found"] } };
      issue.worklogs = issue.worklogs.filter((w) => w.id !== m![2]);
      return { status: 204 };
    }

    m = path.match(/^issue\/([^/]+)\/worklog$/);
    if (m) {
      const issue = this.issues.get(m[1]);
      if (!issue) return { status: 404, body: { errorMessages: ["not found"] } };
      if (method === "GET") {
        const startAt = Number(req.query.get("startAt") ?? 0);
        const maxResults = Number(req.query.get("maxResults") ?? 100);
        return {
          status: 200,
          body: {
            startAt,
            maxResults,
            total: issue.worklogs.length,
            worklogs: issue.worklogs.slice(startAt, startAt + maxResults).map(toWorklogJson),
          },
        };
      }
      if (method === "POST") {
        const b = req.body as { timeSpentSeconds: number; started: string; comment?: unknown };
        const wl = this.addWorklog(m[1], {
          timeSpentSeconds: b.timeSpentSeconds,
          started: b.started,
          comment: extractAdfText(b.comment),
        });
        return { status: 201, body: { id: wl.id } };
      }
    }

    m = path.match(/^issue\/([^/]+)$/);
    if (m) {
      const issue = this.issues.get(m[1]);
      if (!issue) return { status: 404, body: { errorMessages: ["not found"] } };
      if (method === "GET") return { status: 200, body: toIssueJson(issue) };
      if (method === "PUT") {
        this.applyFields(issue, (req.body as { fields: Record<string, unknown> }).fields ?? {});
        return { status: 204 };
      }
    }

    return { status: 404, body: { errorMessages: [`FakeJira: unhandled ${method} ${path}`] } };
  }

  private applyFields(issue: FakeIssue, fields: Record<string, unknown>) {
    if ("customfield_10016" in fields) {
      issue.storyPoints = (fields.customfield_10016 as number | null) ?? null;
    }
    if (fields.priority) issue.priority = (fields.priority as { name: string }).name;
    if (fields.issuetype) issue.issuetype = (fields.issuetype as { name: string }).name;
    if ("description" in fields) issue.description = fields.description;
    if (fields.timetracking) {
      issue.originalEstimateSeconds =
        (fields.timetracking as { originalEstimateSeconds?: number }).originalEstimateSeconds ??
        null;
    }
    issue.updated = new Date().toISOString();
  }

  private search(req: RecordedRequest): { status: number; body: unknown } {
    const { jql } = req.body as { jql: string };
    let matches: FakeIssue[];

    const keyList = jql.match(/^issueKey in \((.*)\)$/);
    const projectMatch = jql.match(/^project = "([^"]+)"/);
    if (keyList) {
      const keys = [...keyList[1].matchAll(/"([^"]+)"/g)].map((k) => k[1]);
      matches = keys.map((k) => this.issues.get(k)).filter((i): i is FakeIssue => Boolean(i));
    } else if (projectMatch) {
      matches = [...this.issues.values()].filter((i) => i.project.key === projectMatch[1]);
    } else {
      matches = [...this.issues.values()].filter((i) => i.inMainQuery);
    }
    return { status: 200, body: { issues: matches.map(toIssueJson), isLast: true } };
  }
}

function toWorklogJson(w: FakeWorklog) {
  return {
    id: w.id,
    author: w.author,
    started: w.started,
    timeSpentSeconds: w.timeSpentSeconds,
    comment: w.comment ? adfParagraph(w.comment) : undefined,
  };
}

function toIssueJson(i: FakeIssue) {
  return {
    key: i.key,
    fields: {
      summary: i.summary,
      description: i.description,
      status: {
        name: i.status,
        statusCategory: { key: STATUS_CATEGORY[i.status] ?? "indeterminate" },
      },
      issuetype: { name: i.issuetype },
      priority: { name: i.priority },
      assignee: i.assignee,
      creator: i.creator,
      customfield_10016: i.storyPoints,
      timetracking:
        i.originalEstimateSeconds != null
          ? { originalEstimateSeconds: i.originalEstimateSeconds }
          : undefined,
      parent: i.parent ? { key: i.parent } : undefined,
      project: i.project,
      created: i.created,
      updated: i.updated,
      worklog: {
        worklogs: i.worklogs.slice(0, INLINE_WORKLOG_LIMIT).map(toWorklogJson),
        total: i.worklogs.length,
        maxResults: INLINE_WORKLOG_LIMIT,
      },
      issuelinks: [],
    },
  };
}

function extractAdfText(adf: unknown): string | null {
  const walk = (n: unknown): string => {
    if (!n || typeof n !== "object") return "";
    const node = n as { text?: string; content?: unknown[] };
    return (node.text ?? "") + (node.content ?? []).map(walk).join("");
  };
  return adf ? walk(adf) || null : null;
}
