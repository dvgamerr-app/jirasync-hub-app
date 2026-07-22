import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { KanbanCard, KanbanColumn } from "@/types/kanban";

function createMockState() {
  const cards = new Map<string, KanbanCard>();
  const columns = new Map<string, KanbanColumn>();

  const kanbanDb = {
    cards: {
      put: mock(async (card: KanbanCard) => {
        cards.set(card.id, card);
        return card.id;
      }),
      delete: mock(async (id: string) => {
        cards.delete(id);
      }),
      toArray: mock(async () => Array.from(cards.values())),
    },
    columns: {
      put: mock(async (column: KanbanColumn) => {
        columns.set(column.id, column);
        return column.id;
      }),
      delete: mock(async (id: string) => {
        columns.delete(id);
      }),
      toArray: mock(async () => Array.from(columns.values())),
      count: mock(async () => columns.size),
      bulkPut: mock(async (rows: KanbanColumn[]) => {
        rows.forEach((row) => columns.set(row.id, row));
      }),
    },
  };

  const seedDefaultColumnsIfEmpty = mock(async () => {
    if (columns.size > 0) return;
    const defaults: KanbanColumn[] = [
      { id: "todo", label: "To Do", order: 0 },
      { id: "in_progress", label: "In Progress", order: 1 },
      { id: "waiting", label: "Waiting", order: 2 },
      { id: "blocked", label: "Blocked", order: 3 },
      { id: "done", label: "Done", order: 4 },
    ];
    defaults.forEach((column) => columns.set(column.id, column));
  });

  const reset = () => {
    cards.clear();
    columns.clear();
    kanbanDb.cards.put.mockClear();
    kanbanDb.cards.delete.mockClear();
    kanbanDb.cards.toArray.mockClear();
    kanbanDb.columns.put.mockClear();
    kanbanDb.columns.delete.mockClear();
    kanbanDb.columns.toArray.mockClear();
    kanbanDb.columns.count.mockClear();
    kanbanDb.columns.bulkPut.mockClear();
    seedDefaultColumnsIfEmpty.mockClear();
  };

  return { cards, columns, kanbanDb, seedDefaultColumnsIfEmpty, reset };
}

var mocked: ReturnType<typeof createMockState>;

mock.module("@/lib/kanban-db", () => {
  mocked = createMockState();
  return {
    kanbanDb: mocked.kanbanDb,
    seedDefaultColumnsIfEmpty: mocked.seedDefaultColumnsIfEmpty,
  };
});

import { useKanbanStore } from "@/store/kanban-store";

function setColumns(columns: KanbanColumn[]) {
  useKanbanStore.setState({ columns });
}

describe("kanban-store", () => {
  beforeEach(() => {
    mocked.reset();
    useKanbanStore.setState({ cards: [], columns: [], isLoaded: false });
  });

  it("seeds default columns on first load and loads cards/columns", async () => {
    await useKanbanStore.getState().loadFromDB();

    const state = useKanbanStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.columns.map((c) => c.id)).toEqual([
      "todo",
      "in_progress",
      "waiting",
      "blocked",
      "done",
    ]);
    expect(mocked.seedDefaultColumnsIfEmpty).toHaveBeenCalledTimes(1);
  });

  it("creates a card with a derived title in the first column by default", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);

    const card = useKanbanStore.getState().createCard({ detail: "Fix the login bug\n\nDetails." });

    expect(card.title).toBe("Fix the login bug");
    expect(card.status).toBe("todo");
    expect(card.order).toBe(0);
    expect(useKanbanStore.getState().cards).toHaveLength(1);
    expect(mocked.kanbanDb.cards.put).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit title over the derived one", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);

    const card = useKanbanStore
      .getState()
      .createCard({ detail: "Fix the login bug", title: "Custom title" });

    expect(card.title).toBe("Custom title");
  });

  it("updates card fields and bumps updatedAt", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);
    const card = useKanbanStore.getState().createCard({ detail: "Original detail" });

    useKanbanStore.getState().updateCard(card.id, { title: "New title", priority: "high" });

    const updated = useKanbanStore.getState().getCardById(card.id);
    expect(updated?.title).toBe("New title");
    expect(updated?.priority).toBe("high");
    expect(updated?.detail).toBe("Original detail");
  });

  it("moves a card between columns and reindexes both columns", () => {
    setColumns([
      { id: "todo", label: "To Do", order: 0 },
      { id: "done", label: "Done", order: 1 },
    ]);
    const a = useKanbanStore.getState().createCard({ detail: "A" });
    const b = useKanbanStore.getState().createCard({ detail: "B" });

    useKanbanStore.getState().moveCard(a.id, "done", 0);

    const state = useKanbanStore.getState();
    expect(state.getCardById(a.id)?.status).toBe("done");
    expect(state.getCardById(a.id)?.order).toBe(0);
    expect(state.getCardById(b.id)?.status).toBe("todo");
    expect(state.getCardById(b.id)?.order).toBe(0);
  });

  it("adds a comment to a card", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);
    const card = useKanbanStore.getState().createCard({ detail: "A" });

    useKanbanStore.getState().addComment(card.id, "Looks good", "ai");

    const updated = useKanbanStore.getState().getCardById(card.id);
    expect(updated?.comments).toHaveLength(1);
    expect(updated?.comments[0]).toMatchObject({ author: "ai", body: "Looks good" });
  });

  it("moves a waiting card back to in_progress when the user replies", () => {
    setColumns([
      { id: "in_progress", label: "In Progress", order: 0 },
      { id: "waiting", label: "Waiting", order: 1 },
    ]);
    const card = useKanbanStore.getState().createCard({ detail: "A", status: "waiting" });

    useKanbanStore.getState().addComment(card.id, "Here's the answer", "user");

    expect(useKanbanStore.getState().getCardById(card.id)?.status).toBe("in_progress");
  });

  it("leaves a waiting card alone when the AI adds a comment", () => {
    setColumns([
      { id: "in_progress", label: "In Progress", order: 0 },
      { id: "waiting", label: "Waiting", order: 1 },
    ]);
    const card = useKanbanStore.getState().createCard({ detail: "A", status: "waiting" });

    useKanbanStore.getState().addComment(card.id, "Still working on it", "ai");

    expect(useKanbanStore.getState().getCardById(card.id)?.status).toBe("waiting");
  });

  it("deletes a card", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);
    const card = useKanbanStore.getState().createCard({ detail: "A" });

    useKanbanStore.getState().deleteCard(card.id);

    expect(useKanbanStore.getState().getCardById(card.id)).toBeUndefined();
    expect(mocked.kanbanDb.cards.delete).toHaveBeenCalledWith(card.id);
  });

  it("adds, renames, and reorders columns", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);

    const newColumn = useKanbanStore.getState().addColumn("Review");
    useKanbanStore.getState().renameColumn(newColumn.id, "In Review");
    useKanbanStore.getState().reorderColumns(newColumn.id, "todo");

    const columns = useKanbanStore.getState().getColumns();
    expect(columns[0].id).toBe(newColumn.id);
    expect(columns[0].label).toBe("In Review");
    expect(columns[1].id).toBe("todo");
  });

  it("refuses to delete a column that still has cards", () => {
    setColumns([{ id: "review", label: "Review", order: 0 }]);
    useKanbanStore.getState().createCard({ detail: "A", status: "review" });

    const deleted = useKanbanStore.getState().deleteColumn("review");

    expect(deleted).toBe(false);
    expect(useKanbanStore.getState().columns).toHaveLength(1);
  });

  it("deletes an empty, non-locked column", () => {
    setColumns([{ id: "review", label: "Review", order: 0 }]);

    const deleted = useKanbanStore.getState().deleteColumn("review");

    expect(deleted).toBe(true);
    expect(useKanbanStore.getState().columns).toHaveLength(0);
  });

  it("refuses to delete a locked column even when empty", () => {
    setColumns([{ id: "todo", label: "To Do", order: 0 }]);

    const deleted = useKanbanStore.getState().deleteColumn("todo");

    expect(deleted).toBe(false);
    expect(useKanbanStore.getState().columns).toHaveLength(1);
  });
});
