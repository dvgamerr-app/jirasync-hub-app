import { useState } from "react";
import {
  getJiraAccounts,
  addJiraAccount,
  updateJiraAccount,
  removeJiraAccount,
  getStoryPointFieldMap,
  saveStoryPointFieldMap,
  db,
  type JiraAccount,
} from "@/lib/jira-db";
import {
  testJiraConnection,
  fetchJiraFields,
  detectStoryPointCandidates,
  type JiraField,
  type StoryPointCandidate,
} from "@/lib/jira-api";
import { startBackgroundSync, stopBackgroundSync } from "@/lib/sync-service";
import { openExternal } from "@/lib/desktop";
import { getOrganizationId } from "@/lib/jira-ids";
import type { Project } from "@/types/jira";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Plus,
  Pencil,
  Trash2,
  Server,
  Settings,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FormMode = "list" | "add" | "edit" | "story-points";

const emptyForm = { name: "", instanceUrl: "", email: "", apiToken: "" };

export function JiraSettingsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <JiraSettingsDialogContent /> : null}
    </Dialog>
  );
}

function JiraSettingsDialogContent() {
  const [accounts, setAccounts] = useState<JiraAccount[]>(() => getJiraAccounts());
  const [mode, setMode] = useState<FormMode>("list");
  const [editing, setEditing] = useState<JiraAccount | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "fail">("idle");

  // Story-point field mapping
  const [spFieldMap, setSpFieldMap] = useState<Record<string, string>>({});
  const [spProjects, setSpProjects] = useState<{ account: JiraAccount; projects: Project[] }[]>([]);
  const [spFields, setSpFields] = useState<Record<string, JiraField[]>>({}); // accountId → fields
  const [spDetected, setSpDetected] = useState<Record<string, StoryPointCandidate[]>>({}); // projectId → detected candidates
  const [spLoading, setSpLoading] = useState(false);

  const refresh = () => setAccounts(getJiraAccounts());

  const startStoryPoints = async () => {
    const currentAccounts = getJiraAccounts();
    const savedMap = getStoryPointFieldMap();
    setSpFieldMap(savedMap);
    setSpDetected({});

    // Load projects from Dexie grouped by account
    const groups: { account: JiraAccount; projects: Project[] }[] = [];
    for (const acc of currentAccounts) {
      const orgId = getOrganizationId(acc.id);
      const projects = await db.projects.where("orgId").equals(orgId).sortBy("name");
      if (projects.length > 0) {
        groups.push({ account: acc, projects });
      }
    }
    setSpProjects(groups);
    setMode("story-points");

    // Phase 1: fetch custom fields per account
    setSpLoading(true);
    const fieldResults = await Promise.allSettled(
      currentAccounts.map(async (acc) => ({
        accountId: acc.id,
        fields: await fetchJiraFields(acc),
      })),
    );
    const fieldsMap: Record<string, JiraField[]> = {};
    for (const r of fieldResults) {
      if (r.status === "fulfilled") fieldsMap[r.value.accountId] = r.value.fields;
    }
    setSpFields(fieldsMap);

    // Phase 2: detect which numeric fields have values in each project
    type DetectJob = { account: JiraAccount; project: Project };
    const jobs: DetectJob[] = groups.flatMap(({ account, projects }) =>
      projects.map((project) => ({ account, project })),
    );
    const detectionResults = await Promise.allSettled(
      jobs.map(({ account, project }) => {
        const numericFields = (fieldsMap[account.id] ?? []).filter(
          (f) => f.schema?.type === "number",
        );
        return detectStoryPointCandidates(account, project.jiraProjectKey, numericFields).then(
          (candidates) => ({ projectId: project.id, candidates }),
        );
      }),
    );

    const detectedMap: Record<string, StoryPointCandidate[]> = {};
    for (const r of detectionResults) {
      if (r.status === "fulfilled") detectedMap[r.value.projectId] = r.value.candidates;
    }
    setSpDetected(detectedMap);

    // Auto-select top candidate for projects that have no saved mapping
    setSpFieldMap((prev) => {
      const next = { ...prev };
      for (const [projectId, candidates] of Object.entries(detectedMap)) {
        if (!prev[projectId] && candidates.length > 0) {
          next[projectId] = candidates[0].id;
        }
      }
      return next;
    });

    setSpLoading(false);
  };

  const saveStoryPoints = () => {
    saveStoryPointFieldMap(spFieldMap);
    setMode("list");
    toast({ title: "Story point fields saved" });
  };

  const startAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setStatus("idle");
    setMode("add");
  };

  const startEdit = (account: JiraAccount) => {
    setEditing(account);
    setForm({
      name: account.name,
      instanceUrl: account.instanceUrl,
      email: account.email,
      apiToken: account.apiToken,
    });
    setStatus("idle");
    setMode("edit");
  };

  const handleDelete = (id: string) => {
    removeJiraAccount(id);
    refresh();
    if (getJiraAccounts().length === 0) {
      stopBackgroundSync();
    }
  };

  const accountFromForm = (): Omit<JiraAccount, "id"> => ({
    name:
      form.name.trim() ||
      form.instanceUrl
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\.atlassian\.net\/?$/, ""),
    instanceUrl: form.instanceUrl.trim(),
    email: form.email.trim(),
    apiToken: form.apiToken.trim(),
  });

  const handleTest = async () => {
    setTesting(true);
    setStatus("idle");
    const ok = await testJiraConnection(
      editing ? { ...editing, ...accountFromForm() } : { id: "test", ...accountFromForm() },
    );
    setStatus(ok ? "ok" : "fail");
    setTesting(false);
    if (!ok)
      toast({
        title: "Connection failed",
        description: "Check credentials and Jira URL",
        variant: "destructive",
      });
  };

  const handleSave = async () => {
    const { instanceUrl, email, apiToken } = form;
    if (!instanceUrl || !email || !apiToken) {
      toast({
        title: "Missing fields",
        description: "Fill in all required fields",
        variant: "destructive",
      });
      return;
    }
    const partial = accountFromForm();
    const testAccount = editing ? { ...editing, ...partial } : { id: "test", ...partial };

    setTesting(true);
    const ok = await testJiraConnection(testAccount);
    setTesting(false);

    if (!ok) {
      setStatus("fail");
      toast({
        title: "Connection failed",
        description: "Check credentials and Jira URL",
        variant: "destructive",
      });
      return;
    }

    if (mode === "edit" && editing) {
      updateJiraAccount({ ...editing, ...partial });
    } else {
      addJiraAccount(partial);
    }

    setStatus("ok");
    refresh();
    startBackgroundSync();
    setMode("list");
  };

  const isFormValid = Boolean(form.instanceUrl && form.email && form.apiToken);

  return (
    <DialogContent className="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle className="text-[15px]">
          {mode === "story-points" ? "Story Point Fields" : "Jira Connections"}
        </DialogTitle>
        <DialogDescription className="text-[12px]">
          {mode === "story-points"
            ? "Choose which Jira custom field holds story points for each project."
            : "Connect one or more Jira instances. Credentials are stored locally only."}
        </DialogDescription>
      </DialogHeader>

      {mode === "list" ? (
        <div className="space-y-3 pt-1">
          {accounts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-8 text-center">
              <Server className="h-8 w-8 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">No Jira accounts configured yet.</p>
              <Button size="sm" className="h-8 text-[13px]" onClick={startAdd}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Account
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                {accounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
                  >
                    <CheckCircle2 className="text-success h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">
                        {acc.name || acc.instanceUrl}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">{acc.email}</p>
                    </div>
                    <button
                      onClick={() => startEdit(acc)}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(acc.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full text-[13px]"
                onClick={startAdd}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Another Account
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full text-[13px]"
                onClick={() => void startStoryPoints()}
              >
                <Settings className="mr-1.5 h-3.5 w-3.5" />
                Story Point Fields
              </Button>
            </>
          )}
        </div>
      ) : mode === "story-points" ? (
        <div className="space-y-3 pt-1">
          {spLoading && (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Detecting story point fields from issues…
            </div>
          )}
          <div className="max-h-[340px] space-y-4 overflow-y-auto">
            {spProjects.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-muted-foreground">
                No projects found. Run a sync first to populate projects.
              </p>
            ) : (
              spProjects.map(({ account, projects }) => {
                const allCustom = spFields[account.id] ?? [];
                const numericFields = allCustom.filter((f) => f.schema?.type === "number");
                const fallbackFields = numericFields.length > 0 ? numericFields : allCustom;

                return (
                  <div key={account.id} className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {account.name || account.instanceUrl}
                    </p>
                    {projects.map((project) => {
                      const currentFieldId = spFieldMap[project.id] ?? "";
                      const detected = spDetected[project.id];
                      const dropdownFields: Array<JiraField & { occurrences?: number }> =
                        detected && detected.length > 0 ? detected : fallbackFields;

                      return (
                        <div
                          key={project.id}
                          className="rounded-md border border-border bg-muted/30 px-3 py-2"
                        >
                          <div className="mb-1.5 flex items-baseline gap-2">
                            <p className="truncate text-[13px] font-medium">{project.name}</p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {project.jiraProjectKey}
                            </span>
                            {detected && detected.length > 0 && (
                              <span className="ml-auto shrink-0 rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
                                auto-detected
                              </span>
                            )}
                            {spLoading && !detected && (
                              <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                            )}
                          </div>
                          {dropdownFields.length > 0 ? (
                            <Select
                              value={currentFieldId}
                              onValueChange={(value) =>
                                setSpFieldMap((prev) => ({ ...prev, [project.id]: value }))
                              }
                            >
                              <SelectTrigger className="h-8 w-full text-[12px]">
                                <SelectValue placeholder="Select field…" />
                              </SelectTrigger>
                              <SelectContent>
                                {dropdownFields.map((f) => (
                                  <SelectItem key={f.id} value={f.id} className="text-[12px]">
                                    <span className="font-medium">{f.name}</span>
                                    <span className="ml-1 text-muted-foreground">({f.id})</span>
                                    {"occurrences" in f && f.occurrences != null && (
                                      <span className="ml-1.5 text-green-600 dark:text-green-400">
                                        {f.occurrences} issues
                                      </span>
                                    )}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              className="h-8 w-full text-[12px]"
                              placeholder="customfield_10016"
                              value={currentFieldId}
                              onChange={(e) =>
                                setSpFieldMap((prev) => ({
                                  ...prev,
                                  [project.id]: e.target.value.trim(),
                                }))
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-[13px]"
              onClick={() => setMode("list")}
            >
              Cancel
            </Button>
            <Button className="h-9 flex-1 text-[13px]" onClick={saveStoryPoints}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label className="text-[12px]">
              Display Name <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              className="h-9 text-[13px]"
              placeholder="e.g. My Company"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">
              Jira Instance URL <span className="text-destructive">*</span>
            </Label>
            <Input
              className="h-9 text-[13px]"
              placeholder="acme or https://acme.atlassian.net"
              value={form.instanceUrl}
              onChange={(e) => {
                setForm((f) => ({ ...f, instanceUrl: e.target.value }));
                setStatus("idle");
              }}
            />
            <p className="text-[11px] text-muted-foreground">Subdomain or full URL</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">
              Email <span className="text-destructive">*</span>
            </Label>
            <Input
              className="h-9 text-[13px]"
              type="email"
              placeholder="you@company.com"
              value={form.email}
              onChange={(e) => {
                setForm((f) => ({ ...f, email: e.target.value }));
                setStatus("idle");
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">
              API Token <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Input
                className="h-9 pr-9 text-[13px]"
                type={showToken ? "text" : "password"}
                placeholder="Jira API token"
                value={form.apiToken}
                onChange={(e) => {
                  setForm((f) => ({ ...f, apiToken: e.target.value }));
                  setStatus("idle");
                }}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Generate at{" "}
              <button
                type="button"
                className="text-primary underline"
                onClick={() =>
                  void openExternal("https://id.atlassian.net/manage-profile/security/api-tokens")
                }
              >
                Atlassian API tokens
              </button>
            </p>
          </div>

          {status !== "idle" && (
            <div
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${
                status === "ok"
                  ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {status === "ok" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              {status === "ok" ? "Connected successfully" : "Connection failed — check credentials"}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-[13px]"
              onClick={() => setMode("list")}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="h-9 flex-1 text-[13px]"
              onClick={handleTest}
              disabled={testing || !isFormValid}
            >
              {testing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Test
            </Button>
            <Button
              className="h-9 flex-1 text-[13px]"
              onClick={handleSave}
              disabled={testing || !isFormValid}
            >
              {testing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {mode === "edit" ? "Update" : "Save & Connect"}
            </Button>
          </div>
        </div>
      )}
    </DialogContent>
  );
}
