import { describe, expect, it } from "bun:test";
import {
  getKanbanBoardOverview,
  getKanbanCardPreview,
  getKanbanColumnStats,
  getKanbanDueState,
  matchesKanbanFilters,
} from "@/lib/kanban-board";
import type { KanbanCard } from "@/types/kanban";

const now = new Date("2026-07-10T09:00:00.000Z");

function buildCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "kb-1",
    title: "Fix login",
    detail: "Fix login\n\nThe form rejects valid passwords.",
    status: "todo",
    order: 0,
    comments: [],
    createdAt: "2026-07-08T09:00:00.000Z",
    updatedAt: "2026-07-09T09:00:00.000Z",
    ...overrides,
  };
}

describe("kanban-board helpers", () => {
  it("classifies due dates into attention-friendly states", () => {
    expect(getKanbanDueState(buildCard({ dueDate: "2026-07-09" }), now)).toBe("overdue");
    expect(getKanbanDueState(buildCard({ dueDate: "2026-07-10" }), now)).toBe("today");
    expect(getKanbanDueState(buildCard({ dueDate: "2026-07-12" }), now)).toBe("due_soon");
    expect(getKanbanDueState(buildCard({ dueDate: "2026-07-20" }), now)).toBe("upcoming");
    expect(getKanbanDueState(buildCard(), now)).toBe("none");
  });

  it("builds a readable preview from the body after the title", () => {
    expect(getKanbanCardPreview("Fix login\n\n**Check** [the logs](https://example.com)\n")).toBe(
      "Check the logs",
    );
    expect(getKanbanCardPreview("Single line title only")).toBe("");
  });

  it("filters cards by attention, priority, and query", () => {
    const card = buildCard({
      title: "Sync billing API",
      detail: "Sync billing API\n\nWaiting for payment gateway response.",
      status: "waiting",
      priority: "high",
      tags: ["backend"],
      jiraLinks: [{ issueKey: "BILL-42", type: "relates_to" }],
      dueDate: "2026-07-11",
    });

    expect(
      matchesKanbanFilters(card, { query: "", view: "attention", priority: "all" }, now),
    ).toBe(true);
    expect(
      matchesKanbanFilters(card, { query: "gateway", view: "waiting", priority: "high" }, now),
    ).toBe(true);
    expect(matchesKanbanFilters(card, { query: "frontend", view: "all", priority: "all" }, now)).toBe(
      false,
    );
    expect(matchesKanbanFilters(card, { query: "", view: "done", priority: "all" }, now)).toBe(
      false,
    );
  });

  it("summarizes board and column attention counts", () => {
    const cards = [
      buildCard({ id: "1", status: "todo", priority: "high", dueDate: "2026-07-10" }),
      buildCard({ id: "2", status: "waiting" }),
      buildCard({ id: "3", status: "blocked", dueDate: "2026-07-09" }),
      buildCard({ id: "4", status: "done", dueDate: "2026-07-12" }),
    ];

    expect(getKanbanBoardOverview(cards, now)).toMatchObject({
      total: 4,
      open: 3,
      done: 1,
      waiting: 1,
      blocked: 1,
      overdue: 1,
      dueSoon: 2,
      highPriority: 1,
      attention: 3,
    });

    expect(getKanbanColumnStats(cards, now)).toMatchObject({
      total: 4,
      overdue: 1,
      dueSoon: 2,
      highPriority: 1,
    });
  });
});
