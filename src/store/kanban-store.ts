import { create } from "zustand";
import { LOCKED_KANBAN_COLUMN_IDS } from "@/constants/kanban";
import { kanbanDb, seedDefaultColumnsIfEmpty } from "@/lib/kanban-db";
import { deriveTitleFromDetail } from "@/lib/kanban-utils";
import type { KanbanCard, KanbanColumn, KanbanComment, KanbanCommentAuthor } from "@/types/kanban";

export interface CreateCardInput {
  detail: string;
  title?: string;
  status?: string;
  jiraLinks?: KanbanCard["jiraLinks"];
  startDate?: string;
  dueDate?: string;
  priority?: KanbanCard["priority"];
  tags?: string[];
}

export type UpdateCardInput = Partial<
  Pick<KanbanCard, "title" | "detail" | "jiraLinks" | "startDate" | "dueDate" | "priority" | "tags">
>;

export interface KanbanStore {
  cards: KanbanCard[];
  columns: KanbanColumn[];
  isLoaded: boolean;

  loadFromDB: () => Promise<void>;

  createCard: (input: CreateCardInput) => KanbanCard;
  updateCard: (cardId: string, updates: UpdateCardInput) => void;
  moveCard: (cardId: string, toStatus: string, toIndex: number) => void;
  addComment: (cardId: string, body: string, author?: KanbanCommentAuthor) => void;
  deleteCard: (cardId: string) => void;

  addColumn: (label: string) => KanbanColumn;
  renameColumn: (columnId: string, label: string) => void;
  reorderColumns: (activeId: string, overId: string) => void;
  /** Returns false (and does nothing) if the column is locked or still has cards. */
  deleteColumn: (columnId: string) => boolean;

  getCardsByStatus: (columnId: string) => KanbanCard[];
  getCardById: (cardId: string) => KanbanCard | undefined;
  getColumns: () => KanbanColumn[];
}

function persistCardInBackground(card: KanbanCard): void {
  void kanbanDb.cards.put(card).catch((error) => {
    console.error(`Failed to persist kanban card ${card.id}:`, error);
  });
}

function persistColumnInBackground(column: KanbanColumn): void {
  void kanbanDb.columns.put(column).catch((error) => {
    console.error(`Failed to persist kanban column ${column.id}:`, error);
  });
}

function replaceCard(cards: KanbanCard[], next: KanbanCard): KanbanCard[] {
  return cards.map((card) => (card.id === next.id ? next : card));
}

export const useKanbanStore = create<KanbanStore>((set, get) => ({
  cards: [],
  columns: [],
  isLoaded: false,

  loadFromDB: async () => {
    await seedDefaultColumnsIfEmpty();
    const [columns, cards] = await Promise.all([
      kanbanDb.columns.toArray(),
      kanbanDb.cards.toArray(),
    ]);
    set({ columns, cards, isLoaded: true });
  },

  createCard: (input) => {
    const status = input.status ?? get().getColumns()[0]?.id ?? "todo";
    const columnCards = get().cards.filter((card) => card.status === status);
    const order =
      columnCards.length > 0 ? Math.max(...columnCards.map((card) => card.order)) + 1 : 0;
    const now = new Date().toISOString();

    const card: KanbanCard = {
      id: `kb-${crypto.randomUUID()}`,
      title: input.title?.trim() || deriveTitleFromDetail(input.detail),
      detail: input.detail,
      status,
      order,
      jiraLinks: input.jiraLinks,
      startDate: input.startDate,
      dueDate: input.dueDate,
      priority: input.priority,
      tags: input.tags,
      comments: [],
      createdAt: now,
      updatedAt: now,
    };

    persistCardInBackground(card);
    set((state) => ({ cards: [...state.cards, card] }));
    return card;
  },

  updateCard: (cardId, updates) => {
    set((state) => {
      const card = state.cards.find((candidate) => candidate.id === cardId);
      if (!card) return state;
      const updated: KanbanCard = { ...card, ...updates, updatedAt: new Date().toISOString() };
      persistCardInBackground(updated);
      return { cards: replaceCard(state.cards, updated) };
    });
  },

  moveCard: (cardId, toStatus, toIndex) => {
    set((state) => {
      const card = state.cards.find((candidate) => candidate.id === cardId);
      if (!card) return state;
      const fromStatus = card.status;
      const now = new Date().toISOString();

      const destCards = state.cards
        .filter((candidate) => candidate.status === toStatus && candidate.id !== cardId)
        .sort((a, b) => a.order - b.order);
      const clampedIndex = Math.max(0, Math.min(toIndex, destCards.length));
      destCards.splice(clampedIndex, 0, card);

      const updatedDest = destCards.map((candidate, index) => ({
        ...candidate,
        status: toStatus,
        order: index,
        updatedAt: candidate.id === cardId ? now : candidate.updatedAt,
      }));

      let updatedSource: KanbanCard[] = [];
      if (fromStatus !== toStatus) {
        const sourceCards = state.cards
          .filter((candidate) => candidate.status === fromStatus && candidate.id !== cardId)
          .sort((a, b) => a.order - b.order);
        updatedSource = sourceCards.map((candidate, index) => ({ ...candidate, order: index }));
      }

      const updatedById = new Map([...updatedDest, ...updatedSource].map((c) => [c.id, c]));
      updatedById.forEach((updated) => persistCardInBackground(updated));

      return {
        cards: state.cards.map((candidate) => updatedById.get(candidate.id) ?? candidate),
      };
    });
  },

  addComment: (cardId, body, author = "user") => {
    set((state) => {
      const card = state.cards.find((candidate) => candidate.id === cardId);
      if (!card) return state;
      const comment: KanbanComment = {
        id: `kbc-${crypto.randomUUID()}`,
        author,
        body,
        createdAt: new Date().toISOString(),
      };
      const updated: KanbanCard = {
        ...card,
        comments: [...card.comments, comment],
        updatedAt: comment.createdAt,
      };
      persistCardInBackground(updated);
      return { cards: replaceCard(state.cards, updated) };
    });

    // A user reply means the AI's question has been answered — resume work automatically.
    const card = get().cards.find((candidate) => candidate.id === cardId);
    if (author === "user" && card?.status === "waiting") {
      const destCards = get().getCardsByStatus("in_progress");
      get().moveCard(cardId, "in_progress", destCards.length);
    }
  },

  deleteCard: (cardId) => {
    void kanbanDb.cards.delete(cardId).catch((error) => {
      console.error(`Failed to delete kanban card ${cardId}:`, error);
    });
    set((state) => ({ cards: state.cards.filter((card) => card.id !== cardId) }));
  },

  addColumn: (label) => {
    const columns = get().columns;
    const order = columns.length > 0 ? Math.max(...columns.map((column) => column.order)) + 1 : 0;
    const column: KanbanColumn = { id: `col-${crypto.randomUUID()}`, label: label.trim(), order };
    persistColumnInBackground(column);
    set((state) => ({ columns: [...state.columns, column] }));
    return column;
  },

  renameColumn: (columnId, label) => {
    set((state) => {
      const column = state.columns.find((candidate) => candidate.id === columnId);
      if (!column) return state;
      const updated: KanbanColumn = { ...column, label: label.trim() };
      persistColumnInBackground(updated);
      return { columns: state.columns.map((c) => (c.id === columnId ? updated : c)) };
    });
  },

  reorderColumns: (activeId, overId) => {
    set((state) => {
      const columns = [...state.columns].sort((a, b) => a.order - b.order);
      const fromIndex = columns.findIndex((column) => column.id === activeId);
      const toIndex = columns.findIndex((column) => column.id === overId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return state;

      const [moved] = columns.splice(fromIndex, 1);
      columns.splice(toIndex, 0, moved);
      const reordered = columns.map((column, index) => ({ ...column, order: index }));
      reordered.forEach(persistColumnInBackground);
      return { columns: reordered };
    });
  },

  deleteColumn: (columnId) => {
    if (LOCKED_KANBAN_COLUMN_IDS.includes(columnId)) return false;

    const hasCards = get().cards.some((card) => card.status === columnId);
    if (hasCards) return false;

    void kanbanDb.columns.delete(columnId).catch((error) => {
      console.error(`Failed to delete kanban column ${columnId}:`, error);
    });
    set((state) => ({ columns: state.columns.filter((column) => column.id !== columnId) }));
    return true;
  },

  getCardsByStatus: (columnId) =>
    get()
      .cards.filter((card) => card.status === columnId)
      .sort((a, b) => a.order - b.order),

  getCardById: (cardId) => get().cards.find((card) => card.id === cardId),

  getColumns: () => [...get().columns].sort((a, b) => a.order - b.order),
}));
