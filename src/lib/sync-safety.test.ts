import { describe, expect, it } from "bun:test";
import { getDescriptionSearchText, getSafeExternalUrl } from "@/lib/adf-content";
import { getJiraBaseUrl, validateJiraInstanceUrl } from "@/lib/jira-db";
import { runExclusiveSync } from "@/lib/sync-lock";
import { describeSyncError, mergeRemoteTaskWithLocalState } from "@/lib/sync-service";
import { describeMinutes, parseMandayInput, parseTimeInput } from "@/lib/worklog-time";
import { isCountedWorkLog, isOwnWorkLog } from "@/lib/worklog-sync";
import { mapWithConcurrency } from "@/lib/utils";
import type { Task, WorkLog } from "@/types/jira";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-acc-PRJ-1",
    projectId: "proj-acc-PRJ",
    jiraTaskId: "PRJ-1",
    title: "t",
    description: null,
    status: "To Do",
    type: "Task",
    severity: "Medium",
    storyLevel: null,
    mandays: null,
    assignee: null,
    refUrl: null,
    note: null,
    isSynced: true,
    isDirty: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function worklog(overrides: Partial<WorkLog> = {}): WorkLog {
  return {
    id: "wl-1",
    taskId: "task-acc-PRJ-1",
    timeSpentMinutes: 60,
    logDate: "2026-03-01",
    comment: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseMandayInput", () => {
  it("treats a bare number as days", () => {
    expect(parseMandayInput("2")).toBe(960);
    expect(parseMandayInput("0.5")).toBe(240);
  });

  it("still understands d/h/m text", () => {
    expect(parseMandayInput("1d 4h")).toBe(720);
    expect(parseMandayInput("90m")).toBe(90);
  });

  it("rejects text and zero", () => {
    expect(parseMandayInput("abc")).toBeNull();
    expect(parseMandayInput("")).toBeNull();
    expect(parseMandayInput("0")).toBeNull();
  });

  it("leaves Log Work semantics alone: a bare number is hours there", () => {
    expect(parseTimeInput("2")).toBe(120);
  });

  it("describes minutes with an hour total", () => {
    expect(describeMinutes(960)).toBe("2d (16h)");
    expect(describeMinutes(30)).toBe("30m (0.5h)");
  });
});

describe("worklog ownership", () => {
  it("counts unknown and own authors, not teammates", () => {
    expect(isOwnWorkLog(worklog())).toBe(true);
    expect(isOwnWorkLog(worklog({ isOwn: null }))).toBe(true);
    expect(isOwnWorkLog(worklog({ isOwn: true }))).toBe(true);
    expect(isOwnWorkLog(worklog({ isOwn: false }))).toBe(false);
  });

  it("never counts a worklog pending deletion or a teammate's", () => {
    expect(isCountedWorkLog(worklog())).toBe(true);
    expect(isCountedWorkLog(worklog({ syncStatus: "pending_delete" }))).toBe(false);
    expect(isCountedWorkLog(worklog({ isOwn: false }))).toBe(false);
  });
});

describe("mergeRemoteTaskWithLocalState", () => {
  const remote = task({ severity: "Low", status: "In Progress", mandays: 3, storyLevel: 5 });

  it("returns the remote task when there is no local copy", () => {
    expect(mergeRemoteTaskWithLocalState(remote)).toBe(remote);
  });

  it("keeps a clean task's local note but takes everything else from Jira", () => {
    const local = task({ note: "mine", severity: "High", isDirty: false });
    const merged = mergeRemoteTaskWithLocalState(remote, local);
    expect(merged.note).toBe("mine");
    expect(merged.severity).toBe("Low");
    expect(merged.isDirty).toBe(false);
  });

  it("keeps only the dirty fields of a dirty task", () => {
    const local = task({
      isDirty: true,
      dirtyFields: ["severity"],
      severity: "Critical",
      status: "To Do",
      mandays: 9,
    });
    const merged = mergeRemoteTaskWithLocalState(remote, local);
    expect(merged.severity).toBe("Critical"); // edited locally
    expect(merged.status).toBe("In Progress"); // not edited → Jira wins
    expect(merged.mandays).toBe(3);
    expect(merged.storyLevel).toBe(5);
    expect(merged.isDirty).toBe(true);
    expect(merged.dirtyFields).toEqual(["severity"]);
  });

  it("treats a dirty task without dirtyFields as fully dirty (legacy record)", () => {
    const local = task({ isDirty: true, severity: "Critical", status: "To Do", mandays: 9 });
    const merged = mergeRemoteTaskWithLocalState(remote, local);
    expect(merged.severity).toBe("Critical");
    expect(merged.status).toBe("To Do");
    expect(merged.mandays).toBe(9);
  });

  it("a worklog-only dirty task (no dirty fields) mirrors Jira", () => {
    const local = task({ isDirty: true, dirtyFields: [], severity: "High" });
    const merged = mergeRemoteTaskWithLocalState(remote, local);
    expect(merged.severity).toBe("Low");
    expect(merged.isDirty).toBe(true);
  });
});

describe("sync error wording", () => {
  it("explains 401 / 403 / 429 and leaves other errors untouched", () => {
    expect(describeSyncError(new Error("Jira API 401: x"))).toContain("token may have expired");
    expect(describeSyncError(new Error("Jira API 403: x"))).toContain("denied");
    expect(describeSyncError(new Error("Jira API 429: x"))).toContain("rate limiting");
    expect(describeSyncError(new Error("Jira API 500: boom"))).toBe("Jira API 500: boom");
  });
});

describe("Jira instance URL", () => {
  it("accepts subdomains and atlassian.net hosts", () => {
    for (const ok of ["acme", "acme.atlassian.net", "https://acme.atlassian.net/", " ACME "]) {
      expect(validateJiraInstanceUrl(ok)).toBeNull();
    }
  });

  it("rejects other hosts, plain http and nonsense", () => {
    for (const bad of ["jira.company.com", "http://acme.atlassian.net", "https://atlassian.net"]) {
      expect(validateJiraInstanceUrl(bad)).not.toBeNull();
    }
  });

  it("builds the base URL without doubling the domain", () => {
    expect(getJiraBaseUrl({ instanceUrl: "acme" })).toBe("https://acme.atlassian.net");
    expect(getJiraBaseUrl({ instanceUrl: "acme.atlassian.net" })).toBe(
      "https://acme.atlassian.net",
    );
    expect(getJiraBaseUrl({ instanceUrl: "https://acme.atlassian.net//" })).toBe(
      "https://acme.atlassian.net",
    );
  });
});

describe("description search text and link safety", () => {
  const adf = JSON.stringify({
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Deploy Gateway" }] },
      { type: "paragraph", content: [{ type: "text", text: "tonight" }] },
    ],
  });

  it("extracts lower-cased visible text only", () => {
    const text = getDescriptionSearchText(adf);
    expect(text).toContain("deploy gateway");
    expect(text).toContain("tonight");
    expect(text).not.toContain("paragraph");
    expect(text).not.toContain("version");
  });

  it("keeps plain-text descriptions and handles empty values", () => {
    expect(getDescriptionSearchText("Plain Text")).toBe("plain text");
    expect(getDescriptionSearchText(null)).toBe("");
  });

  it("only allows http, https and mailto links", () => {
    expect(getSafeExternalUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(getSafeExternalUrl("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(getSafeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(getSafeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(getSafeExternalUrl("not a url")).toBeNull();
    expect(getSafeExternalUrl(undefined)).toBeNull();
  });
});

describe("concurrency helpers", () => {
  it("mapWithConcurrency never exceeds the limit and keeps result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("mapWithConcurrency handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async (n: number) => n)).toEqual([]);
  });

  it("runExclusiveSync runs operations one after another, even when one fails", async () => {
    const order: string[] = [];
    const first = runExclusiveSync(async () => {
      order.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push("a:end");
      throw new Error("a failed");
    });
    const second = runExclusiveSync(async () => {
      order.push("b:start");
      order.push("b:end");
      return "b";
    });
    await expect(first).rejects.toThrow("a failed");
    expect(await second).toBe("b");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});
