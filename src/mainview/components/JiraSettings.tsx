import { useState, useEffect } from "react";
import { getJiraSettings, saveJiraSettings, type JiraSettings as JiraSettingsType } from "@/lib/jira-db";
import { testJiraConnection } from "@/lib/jira-api";
import { startBackgroundSync } from "@/lib/sync-service";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2, XCircle, Eye, EyeOff } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JiraSettingsDialog({ open, onOpenChange }: Props) {
  const [instanceUrl, setInstanceUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    if (open) {
      const saved = getJiraSettings();
      if (saved) {
        setInstanceUrl(saved.instanceUrl);
        setEmail(saved.email);
        setApiToken(saved.apiToken);
        setStatus("idle");
      }
    }
  }, [open]);

  const handleTest = async () => {
    setTesting(true);
    setStatus("idle");
    const settings: JiraSettingsType = { instanceUrl, email, apiToken };
    saveJiraSettings(settings);
    const ok = await testJiraConnection();
    setStatus(ok ? "ok" : "fail");
    setTesting(false);
    if (!ok) toast({ title: "Connection failed", description: "Check your credentials and Jira URL", variant: "destructive" });
  };

  const handleSave = async () => {
    if (!instanceUrl || !email || !apiToken) {
      toast({ title: "Missing fields", description: "Fill in all fields", variant: "destructive" });
      return;
    }
    const settings: JiraSettingsType = { instanceUrl, email, apiToken };
    saveJiraSettings(settings);

    // Test then save
    setTesting(true);
    const ok = await testJiraConnection();
    setTesting(false);

    if (ok) {
      setStatus("ok");
      toast({ title: "Connected to Jira", description: "Starting background sync..." });
      startBackgroundSync();
      onOpenChange(false);
    } else {
      setStatus("fail");
      toast({ title: "Connection failed", description: "Settings saved but connection test failed. Check credentials.", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Jira Settings</DialogTitle>
          <DialogDescription className="text-[12px]">
            Enter your Jira credentials. Data is stored in your browser only.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-[12px]">Jira Instance URL</Label>
            <Input
              className="h-9 text-[13px]"
              placeholder="acme or https://acme.atlassian.net"
              value={instanceUrl}
              onChange={(e) => { setInstanceUrl(e.target.value); setStatus("idle"); }}
            />
            <p className="text-[11px] text-muted-foreground">Subdomain or full URL</p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">Email</Label>
            <Input
              className="h-9 text-[13px]"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setStatus("idle"); }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">API Token</Label>
            <div className="relative">
              <Input
                className="h-9 pr-9 text-[13px]"
                type={showToken ? "text" : "password"}
                placeholder="Jira API token"
                value={apiToken}
                onChange={(e) => { setApiToken(e.target.value); setStatus("idle"); }}
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
              <a href="https://id.atlassian.net/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                Atlassian API tokens
              </a>
            </p>
          </div>

          {/* Status indicator */}
          {status !== "idle" && (
            <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${status === "ok" ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
              {status === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {status === "ok" ? "Connected successfully" : "Connection failed — check credentials"}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1 h-9 text-[13px]" onClick={handleTest} disabled={testing || !instanceUrl || !email || !apiToken}>
              {testing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Test
            </Button>
            <Button className="flex-1 h-9 text-[13px]" onClick={handleSave} disabled={testing || !instanceUrl || !email || !apiToken}>
              {testing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save & Connect
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
