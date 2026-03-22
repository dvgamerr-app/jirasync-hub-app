import { useState, useEffect } from "react";
import {
  getJiraAccounts,
  addJiraAccount,
  updateJiraAccount,
  removeJiraAccount,
  type JiraAccount,
} from "@/lib/jira-db";
import { testJiraConnection } from "@/lib/jira-api";
import { startBackgroundSync, stopBackgroundSync } from "@/lib/sync-service";
import { openExternal } from "@/lib/desktop";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type FormMode = "list" | "add" | "edit";

const emptyForm = { name: "", instanceUrl: "", email: "", apiToken: "" };

export function JiraSettingsDialog({ open, onOpenChange }: Props) {
  const [accounts, setAccounts] = useState<JiraAccount[]>([]);
  const [mode, setMode] = useState<FormMode>("list");
  const [editing, setEditing] = useState<JiraAccount | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    if (open) {
      setAccounts(getJiraAccounts());
      setMode("list");
      setEditing(null);
      setForm(emptyForm);
      setShowToken(false);
      setTesting(false);
      setStatus("idle");
    }
  }, [open]);

  const refresh = () => setAccounts(getJiraAccounts());

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Jira Connections</DialogTitle>
          <DialogDescription className="text-[12px]">
            Connect one or more Jira instances. Credentials are stored locally only.
          </DialogDescription>
        </DialogHeader>

        {mode === "list" ? (
          <div className="space-y-3 pt-1">
            {accounts.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-8 text-center">
                <Server className="h-8 w-8 text-muted-foreground" />
                <p className="text-[13px] text-muted-foreground">
                  No Jira accounts configured yet.
                </p>
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
              </>
            )}
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
                {status === "ok"
                  ? "Connected successfully"
                  : "Connection failed — check credentials"}
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
    </Dialog>
  );
}
