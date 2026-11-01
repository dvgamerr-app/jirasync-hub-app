import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  CircleDot,
  Columns3,
  FileText,
  FolderKanban,
  Eye,
  EyeOff,
  Search,
  RefreshCw,
  X,
} from "lucide-react";
import { filterTasks, useTaskStore } from "@/store/task-store";
import { AI_BOARD_COLUMNS, getAiBoardStatus, isAiBoardCompletedByJira } from "@/lib/ai-board";
import { getJiraAccounts } from "@/lib/jira-db";
import { adfToMarkdown } from "@/lib/adf-content";
import {
  onSyncResult,
  onSyncStatus,
  startBackgroundSync,
  stopBackgroundSync,
} from "@/lib/sync-service";
import { cn, getErrorMessage } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { openExternal } from "@/lib/desktop";
import { getSafeExternalUrl } from "@/lib/adf-content";
import { HANDOFF_TEMPLATE } from "@/lib/ai-context";
import { AdfRenderer } from "@/components/AdfRenderer";
import { CopyForAiDialog } from "@/components/CopyForAiDialog";
import { SummarizeToJiraDialog } from "@/components/SummarizeToJiraDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/StatusBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { Project, Task } from "@/types/jira";
import "./ai-board.css";

const NO_HIDDEN_PROJECTS = new Set<string>();

function reportError(error: unknown) {
  toast({
    title: "Could not complete action",
    description: getErrorMessage(error),
    variant: "destructive",
  });
}

function BoardTaskDetails({ task, project }: { task: Task; project?: Project }) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const { aiStates, move, close, updateNote, copy, summarize } = useTaskStore(
    useShallow((state) => ({
      aiStates: state.aiBoardStates,
      move: state.moveBoardTask,
      close: state.setBoardTask,
      updateNote: state.updateTaskNote,
      copy: state.setBoardCopyTask,
      summarize: state.openSummary,
    })),
  );
  const aiState = aiStates.find((state) => state.id === task.id);
  const completedByJira = isAiBoardCompletedByJira(task, aiState);
  const url = getSafeExternalUrl(task.refUrl);
  return (
    <aside className="board-details" aria-label={`Board details ${task.jiraTaskId}`}>
      <header className="board-detail-meta">
        <span className="board-mono">{task.jiraTaskId}</span>
        <span className="board-project-tag">{project?.jiraProjectKey}</span>
        {url && (
          <button
            type="button"
            className="board-icon-button"
            aria-label="Open ticket in Jira"
            onClick={() => void openExternal(url)}
          >
            <ArrowUpRight size={16} />
          </button>
        )}
        <button
          type="button"
          className="board-icon-button board-close"
          aria-label="Close board details"
          onClick={() => close(null)}
        >
          <X size={18} />
        </button>
      </header>
      <div className="board-detail-title">
        <h2>{task.title}</h2>
      </div>
      <div className="board-detail-body">
        <dl className="board-properties">
          <div className="board-property">
            <dt>AI status</dt>
            <dd>
              <Select
                value={getAiBoardStatus(task, aiState)}
                disabled={completedByJira}
                onValueChange={(value) => void move(task.id, value).catch(reportError)}
              >
                <SelectTrigger aria-label="AI task status" className="h-8 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AI_BOARD_COLUMNS.map((column) => (
                    <SelectItem key={column.id} value={column.id} className="text-[13px]">
                      <StatusBadge status={column.label} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>
          </div>
          {[
            ["Jira status", <StatusBadge key="jira" status={task.status} />],
            ["Type", task.type ?? "—"],
            ["Priority", task.severity ?? "—"],
            ["Assignee", task.assignee ?? "Unassigned"],
            ...(task.parentKey ? [["Parent", task.parentKey]] : []),
            ["AI progress", completedByJira ? "Completed by Jira" : "Saved on this board"],
          ].map(([label, value]) => (
            <div key={String(label)} className="board-property">
              <dt>{label}</dt>
              <dd className="board-readonly-field">{value}</dd>
            </div>
          ))}
        </dl>
        <section className="board-detail-section">
          <h3>Description</h3>
          {task.description ? (
            <AdfRenderer content={task.description} />
          ) : (
            <p className="board-muted">No description available.</p>
          )}
        </section>
        <section className="board-detail-section">
          <div className="board-section-heading">
            <h3>Handoff</h3>
            <span className="board-muted">Local only</span>
          </div>
          <textarea
            key={task.id}
            ref={noteRef}
            aria-label="Board handoff"
            placeholder="Done, next steps, blockers…"
            defaultValue={task.note ?? ""}
            onBlur={(event) => updateNote(task.id, event.target.value.trim() || null)}
            rows={5}
          />
          <button
            type="button"
            className="board-text-button"
            onClick={() => {
              const field = noteRef.current;
              if (!field) return;
              field.value = `${field.value}${field.value ? "\n\n" : ""}${HANDOFF_TEMPLATE}`;
              updateNote(task.id, field.value);
            }}
          >
            Insert handoff template
          </button>
          <p className="board-hint">
            Keep long-term handoffs in your repo. Local notes are removed with the ticket or
            account.
          </p>
        </section>
      </div>
      <div className="board-detail-actions">
        <Button variant="outline" onClick={() => copy(task.id)}>
          Copy for AI
        </Button>
        <Button variant="outline" onClick={() => summarize(task.id)}>
          Summarize to Jira
        </Button>
      </div>
    </aside>
  );
}

export default function AiBoard() {
  const searchRef = useRef<HTMLInputElement>(null);
  const {
    tasks,
    projects,
    organizations,
    projectId,
    taskId,
    query,
    copyId,
    syncing,
    aiStates,
    hiddenProjects,
    toggleVisibility,
    loaded,
    load,
    apply,
    setProject,
    setTask,
    setSearch,
    setCopy,
    setSyncing,
    pull,
  } = useTaskStore(
    useShallow((state) => ({
      tasks: state.tasks,
      projects: state.projects,
      organizations: state.organizations,
      projectId: state.boardProjectId,
      taskId: state.boardTaskId,
      query: state.boardSearch,
      copyId: state.boardCopyTaskId,
      syncing: state.boardSyncing,
      aiStates: state.aiBoardStates,
      hiddenProjects: state.boardHiddenProjectIds,
      toggleVisibility: state.toggleBoardProjectVisibility,
      loaded: state.isLoaded,
      load: state.loadFromDB,
      apply: state.applySyncResult,
      setProject: state.setBoardProject,
      setTask: state.setBoardTask,
      setSearch: state.setBoardSearch,
      setCopy: state.setBoardCopyTask,
      setSyncing: state.setBoardSyncing,
      pull: state.pullBoard,
    })),
  );
  useEffect(() => {
    if (!loaded) void load().catch(reportError);
  }, [loaded, load]);
  useEffect(() => {
    if (!loaded) return;
    const unsubscribeResult = onSyncResult(apply);
    const unsubscribeStatus = onSyncStatus((status, message) => {
      setSyncing(status === "syncing");
      if (status === "error") reportError(new Error(message ?? "Sync failed"));
    });
    if (getJiraAccounts().length > 0) startBackgroundSync();
    return () => {
      unsubscribeResult();
      unsubscribeStatus();
      stopBackgroundSync();
    };
  }, [loaded, apply, setSyncing]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.ctrlKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      const target = event.target;
      if (event.key === "Escape" && target === searchRef.current) {
        setSearch("");
        searchRef.current?.blur();
        return;
      }
      if (
        (target instanceof HTMLElement &&
          (target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target.tagName))) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (
        event.key === "/" ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setTask(null);
    };
    document.addEventListener("keydown", keydown, { capture: true });
    return () => document.removeEventListener("keydown", keydown, { capture: true });
  }, [setTask, setSearch]);

  const aiStatesById = useMemo(
    () => new Map(aiStates.map((state) => [state.id, state])),
    [aiStates],
  );
  const boardTasks = useMemo(
    () =>
      filterTasks(tasks, null, "all", "", NO_HIDDEN_PROJECTS).filter(
        (task) =>
          !task.isEpic &&
          !task.isArchived &&
          !isAiBoardCompletedByJira(task, aiStatesById.get(task.id)),
      ),
    [tasks, aiStatesById],
  );
  const visible = useMemo(
    () => filterTasks(boardTasks, projectId, "all", query, hiddenProjects),
    [boardTasks, projectId, query, hiddenProjects],
  );
  const project = projects.find((candidate) => candidate.id === projectId);
  const selected = boardTasks.find((task) => task.id === taskId);
  const copyTask = boardTasks.find((task) => task.id === copyId);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const task of boardTasks)
      result.set(task.projectId, (result.get(task.projectId) ?? 0) + 1);
    return result;
  }, [boardTasks]);

  return (
    <div className="ai-board" data-testid="ai-board">
      <aside className="board-sidebar">
        <div className="board-brand">Task Manager</div>
        <nav aria-label="Board projects" className="board-nav">
          <div className="board-shortcuts">
            <a className="board-nav-link" href="#/">
              <ArrowLeft size={17} /> My Work
            </a>
            <button
              type="button"
              className={`board-nav-link ${projectId === null ? "is-active" : ""}`}
              onClick={() => setProject(null)}
            >
              <Columns3 size={17} />
              <span>All projects</span>
              <span className="board-count">
                {boardTasks.filter((task) => !hiddenProjects.has(task.projectId)).length}
              </span>
            </button>
          </div>
          {organizations.map((org) => (
            <Collapsible key={org.id} defaultOpen className="mt-4">
              <CollapsibleTrigger className="text-muted-foreground flex w-full items-center gap-2 px-2.5 py-2 text-[11px] font-semibold tracking-wider uppercase">
                <ChevronDown className="h-3 w-3" />
                {org.name}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 space-y-0.5">
                {projects
                  .filter((candidate) => candidate.orgId === org.id && counts.has(candidate.id))
                  .map((candidate) => (
                    <div
                      key={candidate.id}
                      className={`board-project-row ${hiddenProjects.has(candidate.id) ? "is-hidden" : ""}`}
                    >
                      <button
                        type="button"
                        aria-label={`${org.name}: ${candidate.name}`}
                        className={`board-nav-link ${projectId === candidate.id ? "is-active" : ""}`}
                        onClick={() => setProject(candidate.id)}
                      >
                        <span>{candidate.name}</span>
                        <span className="board-count">{counts.get(candidate.id) ?? 0}</span>
                      </button>
                      <button
                        type="button"
                        className="board-project-visibility"
                        aria-label={`${hiddenProjects.has(candidate.id) ? "Show" : "Hide"} ${org.name}: ${candidate.name}`}
                        title={hiddenProjects.has(candidate.id) ? "Show space" : "Hide space"}
                        onClick={() => {
                          try {
                            toggleVisibility(candidate.id);
                          } catch (error) {
                            reportError(error);
                          }
                        }}
                      >
                        {hiddenProjects.has(candidate.id) ? (
                          <EyeOff size={14} />
                        ) : (
                          <>
                            <FolderKanban size={14} className="board-project-folder" />
                            <Eye size={14} className="board-project-eye" />
                          </>
                        )}
                      </button>
                    </div>
                  ))}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </nav>
        <div className="board-sidebar-footer">
          <p>For you and your coding tools</p>
        </div>
      </aside>
      <main className="board-main">
        <header className="board-toolbar">
          <div className="board-title">
            <h1>{project?.name ?? "All projects"}</h1>
            <span className="board-task-count">{visible.length}</span>
            {project && <span className="board-project-tag">{project.jiraProjectKey}</span>}
            <div className="board-search relative flex items-center">
              <Search className="text-muted-foreground pointer-events-none absolute left-2 h-3 w-3" />
              <Input
                ref={searchRef}
                aria-label="Search board"
                placeholder="Search… (Ctrl+F)"
                value={query}
                onChange={(event) => setSearch(event.target.value)}
                className={cn(
                  "border-border text-muted-foreground placeholder:text-muted-foreground/60 h-8 w-40 rounded-md pl-6 text-[11px] shadow-none transition-[width] duration-200 focus:w-52 focus-visible:ring-1",
                  query ? "pr-6" : "pr-2",
                )}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear board search"
                  className="text-muted-foreground hover:text-foreground absolute right-1.5"
                  onClick={() => {
                    setSearch("");
                    searchRef.current?.focus();
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              aria-label="Sync board"
              disabled={syncing || getJiraAccounts().length === 0}
              onClick={() =>
                void pull().catch(() => {
                  // onSyncStatus already reports pull failures, including background sync.
                })
              }
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              Sync
            </Button>
            <ThemeToggle />
          </div>
        </header>
        <div className="board-workspace">
          <div className="board-content">
            {loaded && boardTasks.length === 0 ? (
              <div className="board-empty">
                <Columns3 size={30} />
                <h2>No AI tasks to show</h2>
                <p>
                  Sync tickets to start AI work. Tasks completed in Jira are hidden from this board.
                </p>
                <a className="board-button" href="#/">
                  Open My Work
                </a>
              </div>
            ) : (
              <div className="board-columns" role="region" aria-label="Task board">
                {AI_BOARD_COLUMNS.map((column, index) => {
                  const status = column.id;
                  const columnTasks = visible.filter(
                    (task) => getAiBoardStatus(task, aiStatesById.get(task.id)) === status,
                  );
                  const done = status === "done";
                  return (
                    <section
                      key={status}
                      className="board-column"
                      data-ai-status={status}
                      aria-label={`${column.label} column`}
                      onDragOver={(event) => {
                        if (event.dataTransfer.types.includes("application/x-jirasync-task"))
                          event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const id = event.dataTransfer.getData("application/x-jirasync-task");
                        if (id)
                          void useTaskStore.getState().moveBoardTask(id, status).catch(reportError);
                      }}
                    >
                      <h2>
                        <span
                          className={`board-status-icon ${done ? "is-done" : index > 0 ? "is-working" : ""}`}
                        >
                          {done ? (
                            <Check size={14} />
                          ) : index > 0 ? (
                            <CircleDot size={14} />
                          ) : (
                            <Circle size={14} />
                          )}
                        </span>
                        {column.label}
                        <span className="board-count">{columnTasks.length}</span>
                      </h2>
                      <div className="board-card-list">
                        {columnTasks.map((task) => (
                          <button
                            key={task.id}
                            type="button"
                            draggable={!isAiBoardCompletedByJira(task, aiStatesById.get(task.id))}
                            className={`board-card ${task.id === taskId ? "is-selected" : ""}`}
                            aria-label={`${task.jiraTaskId}: ${task.title}`}
                            onClick={() => setTask(task.id)}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("application/x-jirasync-task", task.id);
                            }}
                          >
                            <div className="board-card-heading">
                              <span>{task.title}</span>
                              <span className="board-card-key">{task.jiraTaskId}</span>
                            </div>
                            {task.description && <p>{adfToMarkdown(task.description)}</p>}
                            <div className="board-card-footer">
                              <span>
                                <FileText size={12} />
                                {task.type ?? "Task"}
                              </span>
                              {!projectId && (
                                <span>
                                  {
                                    projects.find((candidate) => candidate.id === task.projectId)
                                      ?.jiraProjectKey
                                  }
                                </span>
                              )}
                              <span title="Human workflow in Jira">Jira: {task.status ?? "—"}</span>
                            </div>
                          </button>
                        ))}
                        {columnTasks.length === 0 && (
                          <p className="board-column-empty">
                            {query ? "No matching tasks" : "No tasks"}
                          </p>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            <footer className="board-bottom-hint">
              AI progress is independent · Tasks completed in Jira are hidden
            </footer>
          </div>
          {selected && (
            <BoardTaskDetails
              key={selected.id}
              task={selected}
              project={projects.find((candidate) => candidate.id === selected.projectId)}
            />
          )}
        </div>
      </main>
      {copyTask && (
        <CopyForAiDialog
          key={copyTask.id}
          task={copyTask}
          tasks={tasks}
          onClose={() => setCopy(null)}
        />
      )}
      <SummarizeToJiraDialog />
    </div>
  );
}
