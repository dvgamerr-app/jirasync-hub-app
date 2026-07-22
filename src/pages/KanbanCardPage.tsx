import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Eye, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { JiraLinkPicker } from "@/components/kanban/JiraLinkPicker";
import { MarkdownView } from "@/components/kanban/MarkdownView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  KANBAN_JIRA_LINK_TYPES,
  KANBAN_JIRA_LINK_TYPE_LABELS,
  KANBAN_PRIORITIES,
  KANBAN_PRIORITY_LABELS,
} from "@/constants/kanban";
import { deriveTitleFromDetail } from "@/lib/kanban-utils";
import { useKanbanStore } from "@/store/kanban-store";
import type {
  KanbanCard,
  KanbanColumn,
  KanbanJiraLink,
  KanbanJiraLinkType,
  KanbanPriority,
} from "@/types/kanban";

const NO_PRIORITY = "none";

interface KanbanCardEditorProps {
  card?: KanbanCard;
  columnOptions: KanbanColumn[];
  isCreate: boolean;
  onAddComment: (body: string) => void;
  onBack: () => void;
  onDelete: () => void;
  onSave: (fields: {
    detail: string;
    dueDate?: string;
    jiraLinks?: KanbanJiraLink[];
    priority?: KanbanPriority;
    startDate?: string;
    status?: string;
    tags?: string[];
    title?: string;
  }) => void;
  requestedStatus: string;
}

function KanbanCardEditor({
  card,
  columnOptions,
  isCreate,
  onAddComment,
  onBack,
  onDelete,
  onSave,
  requestedStatus,
}: KanbanCardEditorProps) {
  const [detail, setDetail] = useState(card?.detail ?? "");
  const [status, setStatus] = useState(
    card?.status ?? (requestedStatus || columnOptions[0]?.id || ""),
  );
  const [jiraLinks, setJiraLinks] = useState<KanbanJiraLink[]>(card?.jiraLinks ?? []);
  const [startDate, setStartDate] = useState(card?.startDate ?? "");
  const [dueDate, setDueDate] = useState(card?.dueDate ?? "");
  const [priority, setPriority] = useState<KanbanPriority | "">(card?.priority ?? "");
  const [tagsText, setTagsText] = useState(card?.tags?.join(", ") ?? "");
  const [previewDetail, setPreviewDetail] = useState(false);
  const [commentBody, setCommentBody] = useState("");

  const derivedTitle = useMemo(
    () => (detail.trim() ? deriveTitleFromDetail(detail) : ""),
    [detail],
  );
  const tags = useMemo(
    () =>
      tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    [tagsText],
  );
  const existingIssueKeys = useMemo(() => jiraLinks.map((link) => link.issueKey), [jiraLinks]);
  const statusLabel =
    columnOptions.find((column) => column.id === status)?.label ??
    card?.status ??
    columnOptions[0]?.label ??
    "No column";

  const handleAddLink = (task: { jiraTaskId: string }) => {
    setJiraLinks((links) => [...links, { issueKey: task.jiraTaskId, type: "relates_to" }]);
  };

  const handleChangeLinkType = (issueKey: string, type: KanbanJiraLinkType) => {
    setJiraLinks((links) =>
      links.map((link) => (link.issueKey === issueKey ? { ...link, type } : link)),
    );
  };

  const handleRemoveLink = (issueKey: string) => {
    setJiraLinks((links) => links.filter((link) => link.issueKey !== issueKey));
  };

  const handleSave = () => {
    if (!detail.trim()) return;
    onSave({
      title: derivedTitle || undefined,
      detail,
      status: status || undefined,
      jiraLinks: jiraLinks.length > 0 ? jiraLinks : undefined,
      startDate: startDate || undefined,
      dueDate: dueDate || undefined,
      priority: priority || undefined,
      tags: tags.length > 0 ? tags : undefined,
    });
  };

  const handlePostComment = () => {
    if (!commentBody.trim()) return;
    onAddComment(commentBody.trim());
    setCommentBody("");
  };

  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden">
      <header className="border-border shrink-0 border-b px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 pl-0 text-[12px]" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
              Back to board
            </Button>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-[10px]">
                {statusLabel}
              </Badge>
              {!isCreate && card && (
                <>
                  <Badge variant="outline" className="text-[10px]">
                    {card.comments.length} comment{card.comments.length === 1 ? "" : "s"}
                  </Badge>
                  <span className="text-muted-foreground text-[12px]">
                    Updated {formatDistanceToNow(new Date(card.updatedAt), { addSuffix: true })}
                  </span>
                </>
              )}
            </div>

            <h1 className="mt-3 truncate text-lg font-semibold tracking-tight">
              {derivedTitle || (isCreate ? "New card" : "Edit card")}
            </h1>
            <p className="text-muted-foreground mt-1 max-w-2xl text-[13px] leading-5">
              Keep the writing surface focused, and move workflow metadata to the side so editing
              stays readable.
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {!isCreate && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onDelete}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
            <Button size="sm" className="h-8" onClick={handleSave} disabled={!detail.trim()}>
              {isCreate ? "Create card" : "Save changes"}
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5 px-5 py-5 xl:flex-row">
          <div className="min-w-0 flex-1">
            <div className="rounded-2xl border bg-card/80 p-4 shadow-sm">
              <div className="mb-4 rounded-xl border bg-muted/30 p-3">
                <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.12em] uppercase">
                  Card title
                </p>
                <p className="mt-1 text-sm font-medium">
                  {derivedTitle || "The first meaningful line becomes the board title automatically."}
                </p>
              </div>

              <div className="mb-3 flex items-center justify-between gap-2">
                <Label
                  htmlFor="kanban-detail"
                  className="text-muted-foreground text-[11px] font-semibold tracking-[0.12em] uppercase"
                >
                  Detail (markdown)
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-[12px]"
                  onClick={() => setPreviewDetail((value) => !value)}
                >
                  {previewDetail ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {previewDetail ? "Back to edit" : "Preview"}
                </Button>
              </div>

              {previewDetail ? (
                <div className="min-h-[32rem] overflow-y-auto rounded-xl border p-4">
                  <MarkdownView content={detail || "*Nothing to preview*"} />
                </div>
              ) : (
                <Textarea
                  id="kanban-detail"
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                  className="min-h-[32rem] resize-none font-mono text-[13px] leading-relaxed"
                  placeholder="Write the task in markdown… the first meaningful line becomes the board title."
                  autoFocus={isCreate}
                />
              )}
            </div>
          </div>

          <aside className="w-full shrink-0 space-y-5 xl:w-[360px]">
            <div className="rounded-2xl border bg-card/80 p-4 shadow-sm">
              <div className="space-y-5">
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label>Status</Label>
                    <Select value={status} onValueChange={setStatus}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {columnOptions.map((column) => (
                          <SelectItem key={column.id} value={column.id}>
                            {column.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="kanban-priority">Priority</Label>
                    <Select
                      value={priority || NO_PRIORITY}
                      onValueChange={(value) =>
                        setPriority(value === NO_PRIORITY ? "" : (value as KanbanPriority))
                      }
                    >
                      <SelectTrigger id="kanban-priority">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_PRIORITY}>—</SelectItem>
                        {KANBAN_PRIORITIES.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {KANBAN_PRIORITY_LABELS[entry]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="kanban-start">Start date</Label>
                      <Input
                        id="kanban-start"
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="kanban-due">Due date</Label>
                      <Input
                        id="kanban-due"
                        type="date"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="kanban-tags">Tags (comma separated)</Label>
                    <Input
                      id="kanban-tags"
                      value={tagsText}
                      onChange={(e) => setTagsText(e.target.value)}
                      placeholder="bug, backend"
                    />
                  </div>
                </div>

                <div className="grid gap-2 border-t pt-4">
                  <Label>Linked Jira tickets</Label>
                  <div className="space-y-1.5">
                    {jiraLinks.map((link) => (
                      <div
                        key={link.issueKey}
                        className="bg-muted/40 flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                      >
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {link.issueKey}
                        </Badge>
                        <Select
                          value={link.type}
                          onValueChange={(value) =>
                            handleChangeLinkType(link.issueKey, value as KanbanJiraLinkType)
                          }
                        >
                          <SelectTrigger className="h-7 flex-1 text-[12px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {KANBAN_JIRA_LINK_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {KANBAN_JIRA_LINK_TYPE_LABELS[type]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={() => handleRemoveLink(link.issueKey)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <JiraLinkPicker excludeIssueKeys={existingIssueKeys} onSelect={handleAddLink} />
                </div>
              </div>
            </div>

            {!isCreate && card && (
              <div className="rounded-2xl border bg-card/80 p-4 shadow-sm">
                <div className="mb-3">
                  <Label>Comments</Label>
                </div>

                <div className="space-y-2">
                  {card.comments.length === 0 && (
                    <p className="text-muted-foreground text-[12px]">No comments yet.</p>
                  )}
                  {card.comments.map((comment) => (
                    <div key={comment.id} className="bg-muted/40 rounded-md border p-2 text-[13px]">
                      <div className="mb-1 flex items-center gap-2">
                        <Badge
                          variant={comment.author === "ai" ? "secondary" : "outline"}
                          className="text-[10px]"
                        >
                          {comment.author === "ai" ? "AI" : "You"}
                        </Badge>
                        <span className="text-muted-foreground text-[11px]">
                          {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <MarkdownView content={comment.body} />
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex gap-2">
                  <Textarea
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder="Add a comment…"
                    className="min-h-[72px] text-[13px]"
                  />
                  <Button type="button" onClick={handlePostComment} disabled={!commentBody.trim()}>
                    Post
                  </Button>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

const KanbanCardPage = () => {
  const navigate = useNavigate();
  const { cardId } = useParams<{ cardId: string }>();
  const [searchParams] = useSearchParams();
  const isCreate = !cardId;
  const requestedStatus = searchParams.get("status") ?? "";

  const {
    isLoaded,
    loadFromDB,
    getCardById,
    createCard,
    updateCard,
    moveCard,
    deleteCard,
    addComment,
    getCardsByStatus,
    getColumns,
  } = useKanbanStore();

  useEffect(() => {
    if (!isLoaded) {
      void loadFromDB();
    }
  }, [isLoaded, loadFromDB]);

  const card = cardId ? getCardById(cardId) : undefined;
  const columnOptions = getColumns();
  const editorKey = isCreate
    ? `new:${requestedStatus || columnOptions[0]?.id || "default"}`
    : cardId || "missing";

  if (!isLoaded) {
    return (
      <div className="bg-background flex h-full w-full items-center justify-center">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading card…
        </div>
      </div>
    );
  }

  if (!isCreate && !card) {
    return (
      <div className="bg-background flex h-full w-full flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground text-sm">This card no longer exists.</p>
        <Button variant="outline" onClick={() => navigate("/kanban")}>
          <ArrowLeft className="h-4 w-4" />
          Back to board
        </Button>
      </div>
    );
  }

  return (
    <KanbanCardEditor
      key={editorKey}
      card={card}
      columnOptions={columnOptions}
      isCreate={isCreate}
      requestedStatus={requestedStatus}
      onBack={() => navigate("/kanban")}
      onDelete={() => {
        if (!cardId) return;
        deleteCard(cardId);
        navigate("/kanban");
      }}
      onSave={(fields) => {
        if (isCreate) {
          createCard(fields);
          navigate("/kanban");
          return;
        }

        if (!cardId) return;

        updateCard(cardId, {
          title: fields.title,
          detail: fields.detail,
          jiraLinks: fields.jiraLinks,
          startDate: fields.startDate,
          dueDate: fields.dueDate,
          priority: fields.priority,
          tags: fields.tags,
        });

        if (fields.status && fields.status !== card?.status) {
          const destinationIndex = getCardsByStatus(fields.status).filter(
            (candidate) => candidate.id !== cardId,
          ).length;
          moveCard(cardId, fields.status, destinationIndex);
        }

        navigate("/kanban");
      }}
      onAddComment={(body) => {
        if (!cardId) return;
        addComment(cardId, body, "user");
      }}
    />
  );
};

export default KanbanCardPage;
