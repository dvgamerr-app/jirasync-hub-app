import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@/lib/desktop";
import { useKanbanStore } from "@/store/kanban-store";
import type { KanbanCard, KanbanColumn } from "@/types/kanban";

interface McpBridgeRequest {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
}

function serializeCard(card: KanbanCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    order: card.order,
    jiraLinks: card.jiraLinks ?? [],
    startDate: card.startDate ?? null,
    dueDate: card.dueDate ?? null,
    priority: card.priority ?? null,
    tags: card.tags ?? [],
    commentCount: card.comments.length,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function serializeCardDetail(card: KanbanCard) {
  return {
    ...serializeCard(card),
    detail: card.detail,
    comments: card.comments,
  };
}

function serializeColumns(columns: KanbanColumn[]) {
  return [...columns]
    .sort((a, b) => a.order - b.order)
    .map((column) => ({ id: column.id, label: column.label, order: column.order }));
}

function isValidStatus(status: unknown): status is string {
  if (typeof status !== "string") return false;
  return useKanbanStore.getState().columns.some((column) => column.id === status);
}

function summarizeChanges(before: KanbanCard, updates: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const previous = (before as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(previous) === JSON.stringify(value)) continue;
    parts.push(`${key}: ${JSON.stringify(previous ?? null)} → ${JSON.stringify(value)}`);
  }
  return parts.length > 0 ? `Updated ${parts.join(", ")}` : null;
}

async function handleRequest({ tool, params }: McpBridgeRequest): Promise<unknown> {
  if (!useKanbanStore.getState().isLoaded) {
    await useKanbanStore.getState().loadFromDB();
  }

  switch (tool) {
    case "list_columns": {
      return { columns: serializeColumns(useKanbanStore.getState().columns) };
    }

    case "list_cards": {
      const { status, tag, jiraIssueKey } = params as {
        status?: string;
        tag?: string;
        jiraIssueKey?: string;
      };
      let cards = useKanbanStore.getState().cards;
      if (status) cards = cards.filter((card) => card.status === status);
      if (tag) cards = cards.filter((card) => card.tags?.includes(tag));
      if (jiraIssueKey) {
        cards = cards.filter((card) =>
          card.jiraLinks?.some((link) => link.issueKey === jiraIssueKey),
        );
      }
      return {
        columns: serializeColumns(useKanbanStore.getState().columns),
        cards: cards.map(serializeCard),
      };
    }

    case "get_card": {
      const { id } = params as { id?: string };
      if (!id) throw new Error("id is required");
      const card = useKanbanStore.getState().getCardById(id);
      if (!card) throw new Error(`No card with id "${id}"`);
      return serializeCardDetail(card);
    }

    case "create_card": {
      const { detail, title, status, jiraIssueKey, startDate, dueDate, priority, tags } =
        params as {
          detail?: string;
          title?: string;
          status?: string;
          jiraIssueKey?: string;
          startDate?: string;
          dueDate?: string;
          priority?: KanbanCard["priority"];
          tags?: string[];
        };
      if (!detail || !detail.trim()) throw new Error("detail is required");
      if (status && !isValidStatus(status)) {
        throw new Error(`Unknown status "${status}". Call list_columns for valid ids.`);
      }

      const card = useKanbanStore.getState().createCard({
        detail,
        title,
        status,
        jiraLinks: jiraIssueKey ? [{ issueKey: jiraIssueKey, type: "relates_to" }] : undefined,
        startDate,
        dueDate,
        priority,
        tags,
      });
      return serializeCardDetail(card);
    }

    case "update_card": {
      const { id, title, detail, jiraIssueKey, startDate, dueDate, priority, tags } = params as {
        id?: string;
        title?: string;
        detail?: string;
        jiraIssueKey?: string;
        startDate?: string;
        dueDate?: string;
        priority?: KanbanCard["priority"];
        tags?: string[];
      };
      if (!id) throw new Error("id is required");
      const before = useKanbanStore.getState().getCardById(id);
      if (!before) throw new Error(`No card with id "${id}"`);

      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (detail !== undefined) updates.detail = detail;
      if (jiraIssueKey !== undefined) {
        const alreadyLinked = before.jiraLinks?.some((link) => link.issueKey === jiraIssueKey);
        updates.jiraLinks = alreadyLinked
          ? before.jiraLinks
          : [...(before.jiraLinks ?? []), { issueKey: jiraIssueKey, type: "relates_to" }];
      }
      if (startDate !== undefined) updates.startDate = startDate;
      if (dueDate !== undefined) updates.dueDate = dueDate;
      if (priority !== undefined) updates.priority = priority;
      if (tags !== undefined) updates.tags = tags;

      useKanbanStore.getState().updateCard(id, updates);

      const changeSummary = summarizeChanges(before, updates);
      if (changeSummary) {
        useKanbanStore.getState().addComment(id, changeSummary, "ai");
      }

      const after = useKanbanStore.getState().getCardById(id);
      return after ? serializeCardDetail(after) : null;
    }

    case "move_card": {
      const { id, status, order } = params as { id?: string; status?: string; order?: number };
      if (!id) throw new Error("id is required");
      if (!status) throw new Error("status is required");
      if (!isValidStatus(status)) {
        throw new Error(`Unknown status "${status}". Call list_columns for valid ids.`);
      }
      const before = useKanbanStore.getState().getCardById(id);
      if (!before) throw new Error(`No card with id "${id}"`);

      const destCards = useKanbanStore.getState().getCardsByStatus(status);
      const toIndex = typeof order === "number" ? order : destCards.length;
      useKanbanStore.getState().moveCard(id, status, toIndex);

      const after = useKanbanStore.getState().getCardById(id);
      return after ? serializeCardDetail(after) : null;
    }

    case "add_comment": {
      const { id, body, awaitingReply } = params as {
        id?: string;
        body?: string;
        awaitingReply?: boolean;
      };
      if (!id) throw new Error("id is required");
      if (!body || !body.trim()) throw new Error("body is required");
      const card = useKanbanStore.getState().getCardById(id);
      if (!card) throw new Error(`No card with id "${id}"`);

      useKanbanStore.getState().addComment(id, body, "ai");

      if (awaitingReply && card.status !== "waiting") {
        const destCards = useKanbanStore.getState().getCardsByStatus("waiting");
        useKanbanStore.getState().moveCard(id, "waiting", destCards.length);
      }

      const after = useKanbanStore.getState().getCardById(id);
      return after ? serializeCardDetail(after) : null;
    }

    default:
      throw new Error(`Unknown MCP tool "${tool}"`);
  }
}

let unlistenFn: UnlistenFn | null = null;

/** Wires the Rust-side MCP HTTP server to this webview's Kanban store. No-op outside Tauri. */
export async function startMcpBridge(): Promise<void> {
  if (!isTauriRuntime() || unlistenFn) return;

  unlistenFn = await listen<McpBridgeRequest>("mcp-bridge-request", (event) => {
    void (async () => {
      const { requestId } = event.payload;
      try {
        const result = await handleRequest(event.payload);
        await invoke("mcp_bridge_respond", { requestId, result: result ?? null, error: null });
      } catch (error) {
        await invoke("mcp_bridge_respond", {
          requestId,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
