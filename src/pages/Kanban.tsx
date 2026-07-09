import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { Plug, Plus, Settings2 } from "lucide-react";
import { KanbanColumnManagerDialog } from "@/components/kanban/KanbanColumnManagerDialog";
import { KanbanColumnView } from "@/components/kanban/KanbanColumnView";
import { McpServerInfoDialog } from "@/components/kanban/McpServerInfoDialog";
import { Button } from "@/components/ui/button";
import { useKanbanStore } from "@/store/kanban-store";

const Kanban = () => {
  const navigate = useNavigate();
  const { cards, columns, isLoaded, loadFromDB, moveCard, getCardsByStatus, getColumns } =
    useKanbanStore();
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);

  useEffect(() => {
    loadFromDB();
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

  const handleOpenCard = (cardId: string) => {
    navigate(`/kanban/card/${cardId}`);
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    moveCard(result.draggableId, result.destination.droppableId, result.destination.index);
  };

  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden">
      <header className="border-border flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[13px] font-semibold">Kanban Board</h1>
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] tabular-nums">
            {cards.length}
          </span>
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
          <Button
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => navigate("/kanban/new")}
          >
            <Plus className="h-3.5 w-3.5" />
            Add card
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        {isLoaded && (
          <DragDropContext onDragEnd={handleDragEnd}>
            <div className="flex h-full gap-3">
              {sortedColumns.map((column) => (
                <KanbanColumnView
                  key={column.id}
                  column={column}
                  cards={cardsByColumn.get(column.id) ?? []}
                  onOpenCard={handleOpenCard}
                />
              ))}
            </div>
          </DragDropContext>
        )}
      </div>

      <KanbanColumnManagerDialog open={columnsDialogOpen} onOpenChange={setColumnsDialogOpen} />
      <McpServerInfoDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
    </div>
  );
};

export default Kanban;
