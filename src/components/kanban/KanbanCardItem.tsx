import { Draggable } from "@hello-pangea/dnd";
import { CalendarClock, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { KANBAN_PRIORITY_LABELS } from "@/constants/kanban";
import { cn } from "@/lib/utils";
import type { KanbanCard as KanbanCardType, KanbanPriority } from "@/types/kanban";

interface KanbanCardItemProps {
  card: KanbanCardType;
  index: number;
  onOpen: (cardId: string) => void;
}

const PRIORITY_CLASSNAME: Record<KanbanPriority, string> = {
  high: "border-red-500/50 text-red-600 dark:text-red-400",
  medium: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  low: "border-border text-muted-foreground",
};

const MAX_VISIBLE_JIRA_LINKS = 2;

export function KanbanCardItem({ card, index, onOpen }: KanbanCardItemProps) {
  const jiraLinks = card.jiraLinks ?? [];
  const visibleLinks = jiraLinks.slice(0, MAX_VISIBLE_JIRA_LINKS);
  const hiddenLinkCount = jiraLinks.length - visibleLinks.length;

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <Card
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={() => onOpen(card.id)}
          className={cn(
            "cursor-pointer p-3 text-sm shadow-sm transition-shadow hover:shadow-md",
            snapshot.isDragging && "ring-primary ring-2",
          )}
        >
          <p className="line-clamp-3 font-medium">{card.title}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {visibleLinks.map((link) => (
              <Badge key={link.issueKey} variant="outline" className="font-mono text-[10px]">
                {link.issueKey}
              </Badge>
            ))}
            {hiddenLinkCount > 0 && (
              <Badge variant="outline" className="text-[10px]">
                +{hiddenLinkCount}
              </Badge>
            )}
            {card.priority && (
              <Badge
                variant="outline"
                className={cn("text-[10px]", PRIORITY_CLASSNAME[card.priority])}
              >
                {KANBAN_PRIORITY_LABELS[card.priority]}
              </Badge>
            )}
            {card.dueDate && (
              <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
                <CalendarClock className="h-3 w-3" />
                {card.dueDate}
              </span>
            )}
            {card.comments.length > 0 && (
              <span className="text-muted-foreground ml-auto flex items-center gap-1 text-[10px]">
                <MessageSquare className="h-3 w-3" />
                {card.comments.length}
              </span>
            )}
          </div>
        </Card>
      )}
    </Draggable>
  );
}
