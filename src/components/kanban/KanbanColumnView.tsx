import { Droppable } from "@hello-pangea/dnd";
import { KanbanCardItem } from "@/components/kanban/KanbanCardItem";
import { cn } from "@/lib/utils";
import type { KanbanCard, KanbanColumn } from "@/types/kanban";

interface KanbanColumnViewProps {
  column: KanbanColumn;
  cards: KanbanCard[];
  onOpenCard: (cardId: string) => void;
}

export function KanbanColumnView({ column, cards, onOpenCard }: KanbanColumnViewProps) {
  return (
    <div className="bg-muted/30 flex h-full w-72 shrink-0 flex-col rounded-lg border">
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="truncate text-[13px] font-semibold">{column.label}</h3>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums">
          {cards.length}
        </span>
      </div>
      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "min-h-[40px] flex-1 space-y-2 overflow-y-auto px-2 pb-2",
              snapshot.isDraggingOver && "bg-accent/40",
            )}
          >
            {cards.map((card, index) => (
              <KanbanCardItem key={card.id} card={card} index={index} onOpen={onOpenCard} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
