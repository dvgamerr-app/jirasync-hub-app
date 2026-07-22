import { Droppable } from "@hello-pangea/dnd";
import { AlertTriangle, Clock3, Plus } from "lucide-react";
import { KanbanCardItem } from "@/components/kanban/KanbanCardItem";
import { Button } from "@/components/ui/button";
import { DEFAULT_KANBAN_COLUMN_UI, KANBAN_COLUMN_UI } from "@/constants/kanban";
import { getKanbanColumnStats } from "@/lib/kanban-board";
import { cn } from "@/lib/utils";
import type { KanbanCard, KanbanColumn } from "@/types/kanban";

interface KanbanColumnViewProps {
  column: KanbanColumn;
  cards: KanbanCard[];
  totalCount: number;
  onCreateCard: (status?: string) => void;
  onOpenCard: (cardId: string) => void;
}

export function KanbanColumnView({
  column,
  cards,
  totalCount,
  onCreateCard,
  onOpenCard,
}: KanbanColumnViewProps) {
  const stats = getKanbanColumnStats(cards);
  const hasHiddenCards = totalCount > cards.length;
  const columnUi = KANBAN_COLUMN_UI[column.id] ?? DEFAULT_KANBAN_COLUMN_UI;

  return (
    <div
      className={cn(
        "flex h-full w-80 shrink-0 flex-col overflow-hidden rounded-2xl border bg-linear-to-b to-transparent shadow-sm",
        columnUi.columnGradient,
      )}
    >
      <div className="border-border bg-card/95 border-b px-3 py-3 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  columnUi.columnDot,
                )}
              />
              <h3 className="truncate text-[13px] font-semibold">{column.label}</h3>
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums">
                {cards.length}
                {hasHiddenCards && <span className="text-muted-foreground/80"> / {totalCount}</span>}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {stats.overdue > 0 && (
                <span className="bg-rose-500/10 text-rose-700 dark:text-rose-300 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
                  <AlertTriangle className="h-3 w-3" />
                  {stats.overdue} overdue
                </span>
              )}
              {stats.dueSoon > 0 && (
                <span className="bg-amber-500/10 text-amber-700 dark:text-amber-300 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
                  <Clock3 className="h-3 w-3" />
                  {stats.dueSoon} due soon
                </span>
              )}
              {stats.highPriority > 0 && (
                <span className="bg-primary/10 text-primary inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium">
                  {stats.highPriority} high priority
                </span>
              )}
              {stats.overdue === 0 && stats.dueSoon === 0 && stats.highPriority === 0 && (
                <span className="text-muted-foreground text-[11px]">No urgent signals in view.</span>
              )}
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => onCreateCard(column.id)}
            title={`Add card in ${column.label}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "min-h-[40px] flex-1 space-y-3 overflow-y-auto px-3 py-3",
              snapshot.isDraggingOver && "bg-accent/40",
            )}
          >
            {cards.length === 0 ? (
              <div className="flex min-h-[13rem] flex-col items-center justify-center rounded-2xl border border-dashed px-5 text-center">
                <p className="text-sm font-medium">
                  {totalCount === 0 ? "No cards in this stage yet." : "No cards match the current search."}
                </p>
                <p className="text-muted-foreground mt-1 text-[12px] leading-5">
                  {totalCount === 0
                    ? "Add a card straight into this column so the workflow stays structured."
                    : "Try clearing the search or check another column."}
                </p>
                {totalCount === 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3 h-8 gap-1.5 text-[12px]"
                    onClick={() => onCreateCard(column.id)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add card here
                  </Button>
                )}
              </div>
            ) : (
              cards.map((card, index) => (
                <KanbanCardItem
                  key={card.id}
                  card={card}
                  index={index}
                  onOpen={onOpenCard}
                />
              ))
            )}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
