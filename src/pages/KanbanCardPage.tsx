import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Eye, Pencil, Trash2, X } from "lucide-react";
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
import type { KanbanJiraLink, KanbanJiraLinkType, KanbanPriority } from "@/types/kanban";

const NO_PRIORITY = "none";

const KanbanCardPage = () => {
  const navigate = useNavigate();
  const { cardId } = useParams<{ cardId: string }>();
  const isCreate = !cardId;

  const { getCardById, createCard, updateCard, deleteCard, addComment } = useKanbanStore();
  const card = cardId ? getCardById(cardId) : undefined;
  const notFound = !isCreate && !card;

  const [detail, setDetail] = useState("");
  const [jiraLinks, setJiraLinks] = useState<KanbanJiraLink[]>([]);
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<KanbanPriority | "">("");
  const [tagsText, setTagsText] = useState("");
  const [previewDetail, setPreviewDetail] = useState(false);
  const [commentBody, setCommentBody] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(card?.detail ?? "");
    setJiraLinks(card?.jiraLinks ?? []);
    setStartDate(card?.startDate ?? "");
    setDueDate(card?.dueDate ?? "");
    setPriority(card?.priority ?? "");
    setTagsText(card?.tags?.join(", ") ?? "");
    setPreviewDetail(false);
    // card is intentionally read only once when this page mounts for a given id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  // There is no title field to fill in — it's always derived from the detail text,
  // and shown live in the header once there's something to derive it from.
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
    const fields = {
      title: derivedTitle || undefined,
      detail,
      jiraLinks: jiraLinks.length > 0 ? jiraLinks : undefined,
      startDate: startDate || undefined,
      dueDate: dueDate || undefined,
      priority: priority || undefined,
      tags: tags.length > 0 ? tags : undefined,
    };

    if (isCreate) {
      createCard(fields);
    } else if (cardId) {
      updateCard(cardId, fields);
    }
    navigate("/kanban");
  };

  const handleDelete = () => {
    if (!cardId) return;
    deleteCard(cardId);
    navigate("/kanban");
  };

  const handleAddComment = () => {
    if (!cardId || !commentBody.trim()) return;
    addComment(cardId, commentBody.trim(), "user");
    setCommentBody("");
  };

  if (notFound) {
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
    <div className="bg-background flex h-full w-full flex-col overflow-hidden">
      <header className="border-border flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => navigate("/kanban")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="truncate text-[13px] font-semibold">
            {derivedTitle || (isCreate ? "New card" : "Edit card")}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isCreate && (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <Button size="sm" className="h-8" onClick={handleSave} disabled={!detail.trim()}>
            {isCreate ? "Create card" : "Save changes"}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Settings rail — secondary fields, out of the way of writing but always visible. */}
        <div className="border-border w-[320px] shrink-0 overflow-y-auto border-r px-5 py-4">
          <div className="space-y-5">
            <div className="grid gap-2">
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

            <div className="grid gap-3">
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
                    {KANBAN_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {KANBAN_PRIORITY_LABELS[p]}
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

            {!isCreate && card && (
              <div className="grid gap-2 border-t pt-4">
                <Label>Comments</Label>
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
                <div className="flex gap-2">
                  <Textarea
                    value={commentBody}
                    onChange={(e) => setCommentBody(e.target.value)}
                    placeholder="Add a comment…"
                    className="min-h-[60px] text-[13px]"
                  />
                  <Button type="button" onClick={handleAddComment} disabled={!commentBody.trim()}>
                    Post
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Detail is the main event — it gets the rest of the screen so writing stays easy. */}
        <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-3">
          <div className="mb-1.5 flex items-center justify-between">
            <Label
              htmlFor="kanban-detail"
              className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
            >
              Detail (markdown)
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-[12px]"
              onClick={() => setPreviewDetail((v) => !v)}
            >
              {previewDetail ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {previewDetail ? "Edit" : "Preview"}
            </Button>
          </div>
          {previewDetail ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
              <MarkdownView content={detail || "*Nothing to preview*"} />
            </div>
          ) : (
            <Textarea
              id="kanban-detail"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              className="min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
              placeholder="Write the task in markdown… the title above is generated from this automatically."
              autoFocus={isCreate}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default KanbanCardPage;
