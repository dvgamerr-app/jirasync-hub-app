import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { Loader2, Plug, Search, Settings2, X } from "lucide-react";
import { KanbanColumnManagerDialog } from "@/components/kanban/KanbanColumnManagerDialog";
import { KanbanColumnView } from "@/components/kanban/KanbanColumnView";
import { McpServerInfoDialog } from "@/components/kanban/McpServerInfoDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { matchesKanbanFilters } from "@/lib/kanban-board";
import { cn } from "@/lib/utils";
import { useKanbanStore } from "@/store/kanban-store";

const Kanban = () => {
  const navigate = useNavigate();
  const { cards, columns, isLoaded, loadFromDB, moveCard, getCardsByStatus, getColumns } =
    useKanbanStore();
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadFromDB();
  }, [loadFromDB]);

  // getColumns()/getCardsByStatus() are stable getter refs — columns/cards must stay in the
  // deps arrays below to force recompute when the underlying store data actually changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sortedColumns = useMemo(() => getColumns(), [columns, getColumns]);
  const cardsByColumn = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getCardsByStatus>>();
    sortedColumns.forEach((column) => map.set(column.id, getCardsByStatus(column.id)));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedColumns, cards, getCardsByStatus]);
  const filters = useMemo(
    () => ({ query, view: "all" as const, priority: "all" as const }),
    [query],
  );
  const filteredCardsByColumn = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getCardsByStatus>>();
    sortedColumns.forEach((column) => {
      const columnCards = cardsByColumn.get(column.id) ?? [];
      map.set(column.id, columnCards.filter((card) => matchesKanbanFilters(card, filters)));
    });
    return map;
  }, [sortedColumns, cardsByColumn, filters]);
  const visibleCardCount = useMemo(() => {
    return sortedColumns.reduce(
      (sum, column) => sum + (filteredCardsByColumn.get(column.id)?.length ?? 0),
      0,
    );
  }, [sortedColumns, filteredCardsByColumn]);
  const hasActiveFilters = query.trim().length > 0;

  const handleOpenCard = (cardId: string) => {
    navigate(`/kanban/card/${cardId}`);
  };

  const handleCreateCard = (status?: string) => {
    const nextUrl = status ? `/kanban/new?status=${encodeURIComponent(status)}` : "/kanban/new";
    navigate(nextUrl);
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    moveCard(result.draggableId, result.destination.droppableId, result.destination.index);
  };

  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden">
      <header className="border-border flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[13px] font-semibold">Kanban</h1>
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] tabular-nums">
            {hasActiveFilters ? visibleCardCount : cards.length}
          </span>
          <div className="relative hidden items-center md:flex">
            <Search className="text-muted-foreground pointer-events-none absolute left-2 h-3 w-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cards…"
              className={cn(
                "border-border text-muted-foreground placeholder:text-muted-foreground/60 h-8 w-40 rounded-md pl-6 text-[11px] shadow-none transition-[width] duration-200 focus-visible:ring-1",
                query ? "pr-6" : "pr-2",
              )}
            />
            {query && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground absolute right-1.5"
                onClick={() => setQuery("")}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => setMcpDialogOpen(true)}
          >
            <Plug className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Connect AI</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => setColumnsDialogOpen(true)}
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Columns</span>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 px-4 py-3">
        {!isLoaded ? (
          <div className="relative grid h-full gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="bg-muted/25 flex min-h-[18rem] flex-col rounded-2xl border p-3"
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="bg-muted h-4 w-24 animate-pulse rounded" />
                  <div className="bg-muted h-5 w-10 animate-pulse rounded-full" />
                </div>
                <div className="space-y-3">
                  <div className="bg-muted h-28 animate-pulse rounded-xl" />
                  <div className="bg-muted h-24 animate-pulse rounded-xl" />
                </div>
              </div>
            ))}
            <div className="text-muted-foreground absolute inset-x-0 bottom-8 flex items-center justify-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading board…
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full rounded-xl border bg-muted/15">
            <DragDropContext onDragEnd={handleDragEnd}>
              <div className="flex h-full min-w-max gap-3 p-3">
                {sortedColumns.map((column) => (
                  <KanbanColumnView
                    key={column.id}
                    column={column}
                    cards={filteredCardsByColumn.get(column.id) ?? []}
                    totalCount={cardsByColumn.get(column.id)?.length ?? 0}
                    onCreateCard={handleCreateCard}
                    onOpenCard={handleOpenCard}
                  />
                ))}
              </div>
            </DragDropContext>
          </ScrollArea>
        )}
      </div>

      <KanbanColumnManagerDialog open={columnsDialogOpen} onOpenChange={setColumnsDialogOpen} />
      <McpServerInfoDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
    </div>
  );
};

export default Kanban;
