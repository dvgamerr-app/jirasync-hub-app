import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { open as openFolderDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { CheckCircle2, CircleAlert, FolderOpen, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useTaskStore } from "@/store/task-store";
import {
  analyzeRepo,
  defaultWorktreeRoot,
  detectRepo,
  type EnvVar,
  type RepoAnalysis,
  type RepoBinding,
  type RepoCommands,
  type RepoDetection,
  type ServiceSpec,
} from "@/lib/harness";
import { cn, getErrorMessage } from "@/lib/utils";
import { BOARD_ACCESS_HOURS } from "@/lib/board-access";
import { parseSnapshot, SNAPSHOT_FILE, type ImportReport } from "@/lib/snapshot";
import { toast } from "@/hooks/use-toast";
import type { Project } from "@/types/jira";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SetupTab = "tools" | "repositories" | "external agents" | "sync";

function StatusIcon({ ok, required }: { ok: boolean; required: boolean }) {
  if (ok) return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="Ready" />;
  if (required) return <XCircle className="text-destructive h-4 w-4" aria-label="Not ready" />;
  return <CircleAlert className="h-4 w-4 text-amber-500" aria-label="Optional, not ready" />;
}

function ToolsSection() {
  const { report, error, running, runDoctor } = useTaskStore(
    useShallow((state) => ({
      report: state.harnessDoctor,
      error: state.harnessDoctorError,
      running: state.harnessDoctorRunning,
      runDoctor: state.runHarnessDoctor,
    })),
  );
  useEffect(() => {
    if (!useTaskStore.getState().harnessDoctor && !useTaskStore.getState().harnessDoctorRunning)
      void runDoctor();
  }, [runDoctor]);

  return (
    <section aria-label="Tools" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px]" role="status">
          {running
            ? "Checking tools…"
            : error
              ? `Could not check tools: ${error}`
              : report?.ready
                ? "All required tools work. The agent can run on this machine."
                : report
                  ? "Fix the required tools below before running an agent."
                  : ""}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={running}
          onClick={() => void runDoctor()}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", running && "animate-spin")} />
          Check again
        </Button>
      </div>
      {report && (
        <ul className="divide-border divide-y rounded-md border text-[13px]">
          {report.tools.map((tool) => (
            <li
              key={tool.name}
              className="flex items-start gap-3 px-3 py-2"
              aria-label={`Tool ${tool.name}`}
            >
              <StatusIcon ok={tool.ok} required={tool.required} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{tool.name}</span>
                  <span className="text-muted-foreground text-[11px]">
                    {tool.required ? "Required" : "Optional"} · {tool.purpose}
                  </span>
                </div>
                <p className={cn("truncate", !tool.ok && "text-destructive")}>
                  {tool.ok ? tool.version : tool.detail}
                </p>
              </div>
            </li>
          ))}
          <li className="flex items-start gap-3 px-3 py-2" aria-label="Tool docker">
            <StatusIcon ok={report.docker.ok} required={false} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">docker</span>
                <span className="text-muted-foreground text-[11px]">
                  Optional · Database and service containers for runs
                </span>
              </div>
              <p className={cn("truncate", !report.docker.ok && "text-destructive")}>
                {report.docker.ok
                  ? `Engine ${report.docker.serverVersion} · ${report.docker.context ?? "default"} · ${report.docker.endpoint ?? "default endpoint"}`
                  : report.docker.detail}
              </p>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
}

const DEFAULT_COPY_ENV = new Set([".env", ".env.local"]);

function BindingEditor({ project, binding }: { project: Project; binding?: RepoBinding }) {
  const { save, remove } = useTaskStore(
    useShallow((state) => ({ save: state.saveRepoBinding, remove: state.removeRepoBinding })),
  );
  const [repoPath, setRepoPath] = useState(binding?.repoPath ?? "");
  const [detection, setDetection] = useState<RepoDetection | null>(null);
  const [analysis, setAnalysis] = useState<RepoAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [baseBranch, setBaseBranch] = useState(binding?.baseBranch ?? "");
  const [worktreeRoot, setWorktreeRoot] = useState(binding?.worktreeRoot ?? "");
  const [commands, setCommands] = useState<RepoCommands>(binding?.commands ?? {});
  const [copyEnv, setCopyEnv] = useState<string[]>(binding?.copyEnv ?? []);
  const [services, setServices] = useState<ServiceSpec[]>(binding?.services ?? []);
  const [overrides, setOverrides] = useState<EnvVar[]>(binding?.envOverrides ?? []);
  const [busy, setBusy] = useState<"detect" | "analyze" | "save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Base branch comes from GitHub; everything else is worked out from the repo by the AI.
  async function detect(path = repoPath) {
    setBusy("detect");
    setError("");
    setDetection(null);
    setAnalysis(null);
    setAnalysisError("");
    let found: RepoDetection;
    try {
      found = await detectRepo(path);
    } catch (detectError) {
      setError(getErrorMessage(detectError));
      setBusy(null);
      return;
    }
    setDetection(found);
    setRepoPath(found.root);
    setBaseBranch(found.defaultBranch);
    setCommands(found.commands);
    setCopyEnv(found.envFiles.filter((file) => DEFAULT_COPY_ENV.has(file)));
    setServices(found.services);
    setOverrides(found.envOverrides);
    try {
      if (!worktreeRoot) setWorktreeRoot(await defaultWorktreeRoot());
      setBusy("analyze");
      const proposed = await analyzeRepo(found.root);
      setAnalysis(proposed);
      setCommands(proposed.commands);
      setServices(proposed.services);
      setCopyEnv(proposed.copyEnv);
      setOverrides(proposed.envOverrides);
    } catch (analyzeError) {
      setAnalysisError(getErrorMessage(analyzeError));
    } finally {
      setBusy(null);
    }
  }

  async function browse() {
    const picked = await openFolderDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setRepoPath(picked);
      await detect(picked);
    }
  }

  async function changeWorktreeRoot() {
    const picked = await openFolderDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setWorktreeRoot(picked);
  }

  async function submit() {
    setBusy("save");
    setError("");
    try {
      await save({
        projectId: project.id,
        repoPath,
        baseBranch,
        worktreeRoot,
        commands,
        copyEnv,
        services,
        envOverrides: overrides,
        updatedAt: 0,
      });
      toast({ title: "Repository saved", description: `${project.name} runs in ${repoPath}` });
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function unbind() {
    setBusy("remove");
    setError("");
    try {
      await remove(project.id);
      setConfirmRemove(false);
    } catch (removeError) {
      setError(getErrorMessage(removeError));
    } finally {
      setBusy(null);
    }
  }

  const canSave =
    !!repoPath && !!baseBranch && !!worktreeRoot && !busy && (!!detection || !!binding);

  return (
    <form
      className="space-y-3 text-[13px]"
      aria-label={`Repository for ${project.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void submit();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="harness-repo-path">Repository folder</Label>
        <div className="flex gap-2">
          <Input
            id="harness-repo-path"
            value={repoPath}
            placeholder="C:\\src\\my-service"
            onChange={(event) => {
              setRepoPath(event.target.value);
              setDetection(null);
            }}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => void browse()}>
            <FolderOpen className="h-3.5 w-3.5" />
            Browse
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!repoPath || !!busy}
            onClick={() => void detect()}
          >
            {(busy === "detect" || busy === "analyze") && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            Analyze
          </Button>
        </div>
      </div>

      {busy === "analyze" && (
        <p className="text-muted-foreground text-[12px]" role="status">
          Reading the repository with AI to work out its commands and services…
        </p>
      )}
      {detection && busy !== "analyze" && (
        <div className="bg-muted/40 space-y-1 rounded-md border p-2 text-[12px]" role="status">
          <p>
            {analysis ? (
              <>
                <strong>{analysis.summary || "Analyzed by AI"}</strong>
              </>
            ) : (
              <>
                Detected <strong>{detection.ecosystem ?? "no known project type"}</strong>
              </>
            )}
            {detection.remoteUrl ? ` · ${detection.remoteUrl}` : " · no origin remote"}
          </p>
          {analysisError && (
            <p className="text-amber-600 dark:text-amber-400">
              AI analysis failed ({analysisError}); using a guess from the repo files.
            </p>
          )}
          {[...(analysis ? [] : detection.notes), ...(analysis?.notes ?? [])].map((note) => (
            <p key={note} className="text-amber-600 dark:text-amber-400">
              {note}
            </p>
          ))}
          {detection.missingExecutables.length > 0 && !analysis && (
            <p className="text-destructive">
              Not installed on this machine: {detection.missingExecutables.join(", ")}
            </p>
          )}
          {detection.envExampleFile && detection.missingEnvKeys.length > 0 && (
            <p>
              Missing from .env (in {detection.envExampleFile}):{" "}
              {detection.missingEnvKeys.join(", ")}
            </p>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">Base branch</dt>
        <dd className="font-mono" aria-label="Base branch">
          {baseBranch || "—"} <span className="text-muted-foreground font-sans">(from GitHub)</span>
        </dd>
        <dt className="text-muted-foreground">Worktree folder</dt>
        <dd className="flex items-start gap-2">
          <span className="font-mono break-all" aria-label="Worktree folder">
            {worktreeRoot || "—"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 shrink-0 px-1.5 text-[11px]"
            onClick={() => void changeWorktreeRoot()}
          >
            Change
          </Button>
        </dd>
      </dl>
      <p className="text-muted-foreground text-[11px]">
        Commands, services and env values are worked out by AI and saved as a .config.json file next
        to the worktrees. If one does not work, fix it in that file.
      </p>

      {error && (
        <p className="text-destructive text-[12px]" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {binding ? (
          confirmRemove ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px]">Remove this binding? Repos and worktrees stay.</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={!!busy}
                onClick={() => void unbind()}
              >
                Confirm remove
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRemove(false)}
              >
                Keep
              </Button>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              Remove binding
            </Button>
          )
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={!canSave}>
          {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save repository
        </Button>
      </div>
    </form>
  );
}

function RepositoriesSection() {
  const { organizations, projects, bindings, loadBindings } = useTaskStore(
    useShallow((state) => ({
      organizations: state.organizations,
      projects: state.projects,
      bindings: state.repoBindings,
      loadBindings: state.loadRepoBindings,
    })),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    loadBindings().catch((error) => setLoadError(getErrorMessage(error)));
  }, [loadBindings]);

  const sorted = useMemo(() => {
    const orgName = new Map(organizations.map((org) => [org.id, org.name]));
    return projects
      .map((project) => ({ project, org: orgName.get(project.orgId) ?? "" }))
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
  }, [organizations, projects]);
  const selected = projects.find((project) => project.id === selectedId);

  if (projects.length === 0)
    return (
      <p className="text-[13px]">Sync your Jira projects first, then bind each to a repository.</p>
    );

  return (
    <section aria-label="Repositories" className="grid grid-cols-[220px_1fr] gap-4">
      <ul className="max-h-[50vh] space-y-1 overflow-y-auto text-[13px]">
        {sorted.map(({ project, org }) => {
          const binding = bindings.find((entry) => entry.projectId === project.id);
          return (
            <li key={project.id}>
              <button
                type="button"
                aria-label={`${org}: ${project.name}`}
                aria-pressed={project.id === selectedId}
                className={cn(
                  "hover:bg-muted w-full rounded-md px-2 py-1.5 text-left",
                  project.id === selectedId && "bg-muted",
                )}
                onClick={() => setSelectedId(project.id)}
              >
                <span className="block truncate font-medium">{project.name}</span>
                <span className="text-muted-foreground block truncate text-[11px]">
                  {org} · {binding ? "Bound" : "Not bound"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div>
        {loadError && (
          <p className="text-destructive mb-2 text-[12px]" role="alert">
            Could not load saved repositories: {loadError}
          </p>
        )}
        {selected ? (
          <BindingEditor
            key={selected.id}
            project={selected}
            binding={bindings.find((entry) => entry.projectId === selected.id)}
          />
        ) : (
          <p className="text-muted-foreground text-[13px]">
            Pick a project to choose the repository its tasks run in.
          </p>
        )}
      </div>
    </section>
  );
}

const SNAPSHOT_FOLDER_KEY = "jirasync-snapshot-folder";

function describeImport(report: ImportReport | null): string {
  if (!report) return "No snapshot in the folder yet.";
  const parts = [
    `${report.aiStates} AI status${report.aiStates === 1 ? "" : "es"}`,
    `${report.notes} note${report.notes === 1 ? "" : "s"}`,
  ];
  if (report.olderIgnored) parts.push(`${report.olderIgnored} older status kept local`);
  if (report.noteConflicts.length)
    parts.push(`notes kept local (different here): ${report.noteConflicts.join(", ")}`);
  if (report.missingTasks.length)
    parts.push(`notes for tasks not synced here: ${report.missingTasks.join(", ")}`);
  if (report.unknownAccounts.length)
    parts.push(`Jira accounts not set up here: ${report.unknownAccounts.join(", ")}`);
  return `Imported ${parts.join(" · ")}.`;
}

function SnapshotSection() {
  const { exportSnapshot, importSnapshot, syncFolder } = useTaskStore(
    useShallow((state) => ({
      exportSnapshot: state.exportSnapshot,
      importSnapshot: state.importSnapshot,
      syncFolder: state.syncSnapshotFolder,
    })),
  );
  const [includeNotes, setIncludeNotes] = useState(false);
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem(SNAPSHOT_FOLDER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function act(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await action());
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }

  const exportFile = () =>
    act(async () => {
      const path = await saveFileDialog({
        defaultPath: SNAPSHOT_FILE,
        filters: [{ name: "JiraSync snapshot", extensions: ["json"] }],
      });
      if (!path) return "";
      await writeTextFile(path, JSON.stringify(exportSnapshot(includeNotes), null, 2));
      return `Saved ${path}`;
    });

  const importFile = (file: File) =>
    act(async () => describeImport(await importSnapshot(parseSnapshot(await file.text()))));

  const sync = () =>
    act(async () => {
      try {
        localStorage.setItem(SNAPSHOT_FOLDER_KEY, folder);
      } catch {
        // Remembering the folder is a convenience only.
      }
      const result = await syncFolder(folder, includeNotes);
      const pushed = result.pushed
        ? "pushed"
        : result.committed
          ? "committed (no upstream to push to)"
          : "nothing new to commit";
      return `${describeImport(result.report)} Snapshot ${pushed}.`;
    });

  return (
    <section aria-label="Sync" className="space-y-3 text-[13px]">
      <p>
        Move your AI Board progress (and, if you choose, local notes) to another machine. Jira data
        comes back with a Jira sync, repository settings stay per machine, and tokens are never
        included. Tasks are matched by Jira site, account email and issue key.
      </p>
      <label className="flex items-center gap-1.5 text-[12px]">
        <input
          type="checkbox"
          checked={includeNotes}
          onChange={(event) => setIncludeNotes(event.target.checked)}
        />
        Include my local notes
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void exportFile()}
        >
          Export file
        </Button>
        <Label className="border-input hover:bg-muted inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-[12px] font-normal">
          Import file
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Import snapshot file"
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </Label>
      </div>
      <div className="space-y-1">
        <Label htmlFor="snapshot-folder">Git sync folder (a clone of a private repository)</Label>
        <div className="flex gap-2">
          <Input
            id="snapshot-folder"
            value={folder}
            placeholder="C:\\src\\jirasync-sync"
            onChange={(event) => setFolder(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void openFolderDialog({ directory: true, multiple: false }).then((picked) => {
                if (typeof picked === "string") setFolder(picked);
              })
            }
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Browse
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !folder.trim()}
            onClick={() => void sync()}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Sync now
          </Button>
        </div>
        <p className="text-muted-foreground text-[11px]">
          Pulls, merges (newer AI status wins, a different local note is kept), then commits and
          pushes only {SNAPSHOT_FILE}. Stop running agents before switching machines.
        </p>
      </div>
      {message && (
        <p className="text-[12px]" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="text-destructive text-[12px]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ExternalAgentsSection() {
  const { access, enable, disable } = useTaskStore(
    useShallow((state) => ({
      access: state.boardAccess,
      enable: state.enableBoard,
      disable: state.disableBoard,
    })),
  );
  const [hours, setHours] = useState<number>(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }

  const config = access?.mcpConfig ? JSON.stringify(access.mcpConfig, null, 2) : "";
  return (
    <section aria-label="External agents" className="space-y-3 text-[13px]">
      <p>
        Let another MCP client (a Claude Code or Codex session, an IDE) see the AI Board To Do tasks
        of bound projects and ask for runs. It never sees your local notes, and nothing starts until
        you approve a request here.
      </p>
      {access ? (
        <>
          <p role="status">
            On until {new Date(access.expiresAt).toLocaleString()}. Closing the app turns it off.
          </p>
          {config ? (
            <div className="space-y-1">
              <Label htmlFor="board-mcp-config">MCP config (keep the token private)</Label>
              <textarea
                id="board-mcp-config"
                readOnly
                rows={8}
                className="bg-muted/40 w-full rounded-md border p-2 font-mono text-[11px]"
                value={config}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(config)
                    .then(() => setCopied(true))
                    .catch((copyError) => setError(getErrorMessage(copyError)))
                }
              >
                {copied ? "Copied" : "Copy config"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-[12px]">
              The token was shown when access was turned on. Turn it on again for a new one.
            </p>
          )}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void act(disable)}
          >
            Turn off
          </Button>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <Label htmlFor="board-hours">Allow for</Label>
          <Select value={String(hours)} onValueChange={(value) => setHours(Number(value))}>
            <SelectTrigger id="board-hours" aria-label="Allow for" className="h-8 w-28 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BOARD_ACCESS_HOURS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} {option === 1 ? "hour" : "hours"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => enable(hours))}
          >
            Turn on
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive text-[12px]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function HarnessSetupDialog() {
  const { open, setOpen } = useTaskStore(
    useShallow((state) => ({ open: state.harnessSetupOpen, setOpen: state.setHarnessSetupOpen })),
  );
  const [tab, setTab] = useState<SetupTab>("tools");
  if (!open) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && setOpen(false)}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogTitle>Agent setup</DialogTitle>
        <DialogDescription>
          Tools and repositories the app uses when it runs a coding agent on a task.
        </DialogDescription>
        <div role="tablist" className="flex gap-1 border-b">
          {(["tools", "repositories", "external agents", "sync"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn(
                "-mb-px border-b-2 px-3 py-1.5 text-[13px] capitalize",
                tab === id
                  ? "border-primary font-medium"
                  : "text-muted-foreground border-transparent",
              )}
              onClick={() => setTab(id)}
            >
              {id}
            </button>
          ))}
        </div>
        {tab === "tools" ? (
          <ToolsSection />
        ) : tab === "repositories" ? (
          <RepositoriesSection />
        ) : tab === "external agents" ? (
          <ExternalAgentsSection />
        ) : (
          <SnapshotSection />
        )}
      </DialogContent>
    </Dialog>
  );
}
