import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, CircleAlert, FolderOpen, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useTaskStore } from "@/store/task-store";
import {
  COMMAND_NAMES,
  defaultWorktreeRoot,
  detectRepo,
  formatCommand,
  parseCommand,
  parseEnvLines,
  formatEnvLines,
  type CommandName,
  type RepoBinding,
  type RepoCommands,
  type RepoDetection,
  type ServiceSpec,
} from "@/lib/harness";
import { cn, getErrorMessage } from "@/lib/utils";
import { BOARD_ACCESS_HOURS } from "@/lib/board-access";
import { toast } from "@/hooks/use-toast";
import type { Project } from "@/types/jira";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

type SetupTab = "tools" | "repositories" | "external agents";

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

type EditableService = ServiceSpec & { include: boolean };

function commandTexts(commands: RepoCommands): Record<CommandName, string> {
  return Object.fromEntries(
    COMMAND_NAMES.map((name) => [name, formatCommand(commands[name])]),
  ) as Record<CommandName, string>;
}

function BindingEditor({ project, binding }: { project: Project; binding?: RepoBinding }) {
  const { save, remove } = useTaskStore(
    useShallow((state) => ({ save: state.saveRepoBinding, remove: state.removeRepoBinding })),
  );
  const [repoPath, setRepoPath] = useState(binding?.repoPath ?? "");
  const [detection, setDetection] = useState<RepoDetection | null>(null);
  const [baseBranch, setBaseBranch] = useState(binding?.baseBranch ?? "");
  const [worktreeRoot, setWorktreeRoot] = useState(binding?.worktreeRoot ?? "");
  const [commands, setCommands] = useState(commandTexts(binding?.commands ?? {}));
  const [copyEnv, setCopyEnv] = useState<string[]>(binding?.copyEnv ?? []);
  const [services, setServices] = useState<EditableService[]>(
    (binding?.services ?? []).map((service) => ({ ...service, include: true })),
  );
  const [overrides, setOverrides] = useState(formatEnvLines(binding?.envOverrides ?? []));
  const [busy, setBusy] = useState<"detect" | "save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const envChoices = useMemo(
    () => [...new Set([...(detection?.envFiles ?? []), ...copyEnv])].sort(),
    [detection, copyEnv],
  );

  async function detect(path = repoPath) {
    setBusy("detect");
    setError("");
    setDetection(null);
    try {
      const result = await detectRepo(path);
      setDetection(result);
      setRepoPath(result.root);
      setBaseBranch(result.defaultBranch);
      setCommands(commandTexts(result.commands));
      setCopyEnv(result.envFiles.filter((file) => DEFAULT_COPY_ENV.has(file)));
      setServices(result.services.map((service) => ({ ...service, include: true })));
      setOverrides(formatEnvLines(result.envOverrides));
      if (!worktreeRoot) setWorktreeRoot(await defaultWorktreeRoot(result.root));
    } catch (detectError) {
      setError(getErrorMessage(detectError));
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

  async function submit() {
    setBusy("save");
    setError("");
    try {
      const parsed: RepoCommands = {};
      for (const name of COMMAND_NAMES) parsed[name] = parseCommand(commands[name]);
      await save({
        projectId: project.id,
        repoPath,
        baseBranch,
        worktreeRoot,
        commands: parsed,
        copyEnv,
        services: services
          .filter((service) => service.include)
          .map(({ include: _include, ...service }) => service),
        envOverrides: parseEnvLines(overrides),
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
            {busy === "detect" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Detect
          </Button>
        </div>
      </div>

      {detection && (
        <div className="bg-muted/40 space-y-1 rounded-md border p-2 text-[12px]" role="status">
          <p>
            Detected <strong>{detection.ecosystem ?? "no known project type"}</strong>
            {detection.remoteUrl ? ` · ${detection.remoteUrl}` : " · no origin remote"}
          </p>
          {detection.notes.map((note) => (
            <p key={note} className="text-amber-600 dark:text-amber-400">
              {note}
            </p>
          ))}
          {detection.missingExecutables.length > 0 && (
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
          {detection.serviceEnvKeys.length > 0 && (
            <p>Service settings: {detection.serviceEnvKeys.join(", ")}</p>
          )}
          {detection.composeFiles.length > 0 && (
            <p>Compose files: {detection.composeFiles.join(", ")}</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="harness-base-branch">Base branch</Label>
          <Input
            id="harness-base-branch"
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="harness-worktree-root">Worktree folder</Label>
          <Input
            id="harness-worktree-root"
            value={worktreeRoot}
            onChange={(event) => setWorktreeRoot(event.target.value)}
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[12px] font-medium">
          Commands the app runs for you (the agent cannot run anything else)
        </legend>
        {COMMAND_NAMES.map((name) => (
          <div key={name} className="grid grid-cols-[64px_1fr] items-center gap-2">
            <Label htmlFor={`harness-command-${name}`} className="text-[12px]">
              {name}
            </Label>
            <Input
              id={`harness-command-${name}`}
              aria-label={`${name} command`}
              className="font-mono text-[12px]"
              placeholder="not set"
              value={commands[name]}
              onChange={(event) =>
                setCommands((current) => ({ ...current, [name]: event.target.value }))
              }
            />
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-2" aria-label="Services">
        <legend className="text-[12px] font-medium">
          Services started per run with Docker (own database, random local ports)
        </legend>
        {services.length === 0 && (
          <p className="text-muted-foreground text-[12px]">
            None. The run uses whatever its .env points at.
          </p>
        )}
        {services.map((service, index) => (
          <div
            key={service.name}
            className="grid grid-cols-[auto_80px_1fr_72px] items-center gap-2"
            aria-label={`Service ${service.name}`}
          >
            <input
              type="checkbox"
              aria-label={`Start ${service.name}`}
              checked={service.include}
              onChange={(event) =>
                setServices((current) =>
                  current.map((entry, i) =>
                    i === index ? { ...entry, include: event.target.checked } : entry,
                  ),
                )
              }
            />
            <span className="font-mono text-[12px]">{service.name}</span>
            <Input
              aria-label={`${service.name} image`}
              className="font-mono text-[12px]"
              value={service.image}
              onChange={(event) =>
                setServices((current) =>
                  current.map((entry, i) =>
                    i === index ? { ...entry, image: event.target.value } : entry,
                  ),
                )
              }
            />
            <Input
              aria-label={`${service.name} port`}
              className="font-mono text-[12px]"
              inputMode="numeric"
              value={service.port || ""}
              onChange={(event) =>
                setServices((current) =>
                  current.map((entry, i) =>
                    i === index ? { ...entry, port: Number(event.target.value) || 0 } : entry,
                  ),
                )
              }
            />
          </div>
        ))}
        <Label htmlFor="harness-env-overrides" className="text-[12px]">
          Per-run .env values (KEY=value; use {"{services.<name>.host}"}, {"{services.<name>.port}"}
          , {"{run.port}"})
        </Label>
        <textarea
          id="harness-env-overrides"
          className="border-input bg-background w-full rounded-md border p-2 font-mono text-[12px]"
          rows={3}
          value={overrides}
          placeholder="DATABASE_URL=postgres://app:app@{services.db.host}:{services.db.port}/app"
          onChange={(event) => setOverrides(event.target.value)}
        />
      </fieldset>

      {envChoices.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-[12px] font-medium">
            Env files copied into each worktree (the agent can read them)
          </legend>
          <div className="flex flex-wrap gap-3">
            {envChoices.map((file) => (
              <label key={file} className="flex items-center gap-1.5 font-mono text-[12px]">
                <input
                  type="checkbox"
                  checked={copyEnv.includes(file)}
                  onChange={(event) =>
                    setCopyEnv((current) =>
                      event.target.checked
                        ? [...current, file]
                        : current.filter((entry) => entry !== file),
                    )
                  }
                />
                {file}
              </label>
            ))}
          </div>
        </fieldset>
      )}

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
      .map((project) => ({
        project,
        label: `${orgName.get(project.orgId) ?? ""}: ${project.name}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [organizations, projects]);
  const selected = projects.find((project) => project.id === selectedId);

  if (projects.length === 0)
    return (
      <p className="text-[13px]">Sync your Jira projects first, then bind each to a repository.</p>
    );

  return (
    <section aria-label="Repositories" className="grid grid-cols-[220px_1fr] gap-4">
      <ul className="max-h-[50vh] space-y-1 overflow-y-auto text-[13px]">
        {sorted.map(({ project, label }) => {
          const binding = bindings.find((entry) => entry.projectId === project.id);
          return (
            <li key={project.id}>
              <button
                type="button"
                aria-label={label}
                aria-pressed={project.id === selectedId}
                className={cn(
                  "hover:bg-muted w-full rounded-md px-2 py-1.5 text-left",
                  project.id === selectedId && "bg-muted",
                )}
                onClick={() => setSelectedId(project.id)}
              >
                <span className="block truncate font-medium">{label}</span>
                <span className="text-muted-foreground block truncate text-[11px]">
                  {binding ? binding.repoPath : "Not bound"}
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
          <select
            id="board-hours"
            className="h-8 rounded-md border px-2 text-[13px]"
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {BOARD_ACCESS_HOURS.map((option) => (
              <option key={option} value={option}>
                {option} {option === 1 ? "hour" : "hours"}
              </option>
            ))}
          </select>
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
          {(["tools", "repositories", "external agents"] as const).map((id) => (
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
        ) : (
          <ExternalAgentsSection />
        )}
      </DialogContent>
    </Dialog>
  );
}
