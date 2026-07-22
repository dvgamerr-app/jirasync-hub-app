import { Draggable } from "@hello-pangea/dnd";
import { format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { CalendarClock, MessageSquare, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DEFAULT_KANBAN_COLUMN_UI, KANBAN_COLUMN_UI, KANBAN_PRIORITY_LABELS } from "@/constants/kanban";
import { getKanbanCardPreview, getKanbanDueState } from "@/lib/kanban-board";
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

const PRIORITY_DOT_CLASSNAME: Record<KanbanPriority, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-slate-400",
};

const MAX_VISIBLE_JIRA_LINKS = 2;
const MAX_VISIBLE_TAGS = 2;

export function KanbanCardItem({ card, index, onOpen }: KanbanCardItemProps) {
  const jiraLinks = card.jiraLinks ?? [];
  const visibleLinks = jiraLinks.slice(0, MAX_VISIBLE_JIRA_LINKS);
  const hiddenLinkCount = jiraLinks.length - visibleLinks.length;
  const tags = card.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTagCount = tags.length - visibleTags.length;
  const dueState = getKanbanDueState(card);
  const preview = getKanbanCardPreview(card.detail);
  const updatedLabel = formatDistanceToNowStrict(new Date(card.updatedAt), { addSuffix: true });
  const dueLabel =
    card.dueDate && dueState !== "none" ? format(parseISO(card.dueDate), "MMM d") : null;
  const columnUi = KANBAN_COLUMN_UI[card.status] ?? DEFAULT_KANBAN_COLUMN_UI;

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <Card
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={() => onOpen(card.id)}
          className={cn(
            "group relative cursor-pointer overflow-hidden border p-3.5 text-sm shadow-sm transition-all hover:-translate-y-px hover:shadow-md",
            columnUi.cardSurface,
            snapshot.isDragging && "ring-primary ring-2 shadow-lg",
          )}
        >
          <div className={cn("absolute inset-x-0 top-0 h-1.5", columnUi.cardAccent)} />

          <div className="flex items-start gap-2.5">
            <span
              className={cn(
                "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                card.priority ? PRIORITY_DOT_CLASSNAME[card.priority] : "bg-muted-foreground/40",
              )}
            />

            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 line-clamp-2 font-medium leading-5">{card.title}</p>
                {dueLabel && (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      dueState === "overdue" &&
                        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
                      dueState === "today" &&
                        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                      dueState === "due_soon" &&
                        "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300",
                      dueState === "upcoming" &&
                        "border-border bg-background/60 text-muted-foreground",
                    )}
                  >
                    <CalendarClock className="h-3 w-3" />
                    {dueState === "overdue"
                      ? `Overdue ${dueLabel}`
                      : dueState === "today"
                        ? "Due today"
                        : dueLabel}
                  </span>
                )}
              </div>

              {preview && (
                <p className="text-muted-foreground mt-1.5 line-clamp-2 text-[12px] leading-4">
                  {preview}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {visibleLinks.map((link) => (
                  <Badge
                    key={link.issueKey}
                    variant="outline"
                    className="bg-background/75 font-mono text-[10px]"
                  >
                    {link.issueKey}
                  </Badge>
                ))}
                {hiddenLinkCount > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    +{hiddenLinkCount} Jira
                  </Badge>
                )}
                {visibleTags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="inline-flex items-center gap-1 text-[10px] font-medium"
                  >
                    <Tag className="h-3 w-3" />
                    {tag}
                  </Badge>
                ))}
                {hiddenTagCount > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    +{hiddenTagCount} tag
                  </Badge>
                )}
                {card.priority && (
                  <Badge
                    variant="outline"
                    className={cn("ml-auto text-[10px]", PRIORITY_CLASSNAME[card.priority])}
                  >
                    {KANBAN_PRIORITY_LABELS[card.priority]}
                  </Badge>
                )}
              </div>

              <div className="text-muted-foreground mt-3 flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate">Updated {updatedLabel}</span>
                {card.comments.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="h-3.5 w-3.5" />
                    {card.comments.length}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}
    </Draggable>
  );
}
