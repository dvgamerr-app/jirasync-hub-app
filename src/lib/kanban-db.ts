import Dexie, { type Table } from "dexie";
import type { KanbanCard, KanbanColumn } from "@/types/kanban";
import { DEFAULT_KANBAN_COLUMNS } from "@/constants/kanban";

class KanbanDatabase extends Dexie {
  cards!: Table<KanbanCard, string>;
  columns!: Table<KanbanColumn, string>;

  constructor() {
    super("kanban-board");
    this.version(1).stores({
      cards: "id, status, order",
      columns: "id, order",
    });
  }
}

export const kanbanDb = new KanbanDatabase();

/** Thai labels an earlier build seeded for these column ids, before they became English. */
const LEGACY_THAI_DEFAULT_LABELS: Record<string, string> = {
  todo: "งาน",
  in_progress: "ทำอยู่",
  waiting: "ส่งงาน",
  blocked: "ติดปัญหา",
  done: "เสร็จแล้ว",
};

/**
 * Writes the default columns once, only if the table has never been populated.
 * Also fixes up columns still carrying an old Thai default label (exact match only —
 * a column the user has since renamed is left untouched).
 */
export async function seedDefaultColumnsIfEmpty(): Promise<void> {
  const existing = await kanbanDb.columns.toArray();

  if (existing.length === 0) {
    await kanbanDb.columns.bulkPut(DEFAULT_KANBAN_COLUMNS);
    return;
  }

  const defaultsById = new Map(DEFAULT_KANBAN_COLUMNS.map((column) => [column.id, column]));
  const toFix = existing
    .filter((column) => LEGACY_THAI_DEFAULT_LABELS[column.id] === column.label)
    .map((column) => ({ ...column, label: defaultsById.get(column.id)?.label ?? column.label }));

  if (toFix.length > 0) {
    await kanbanDb.columns.bulkPut(toFix);
  }
}
