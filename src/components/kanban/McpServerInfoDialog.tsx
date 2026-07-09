import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface McpServerInfo {
  url: string;
  token: string;
}

interface McpServerInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-1.5">
        <Input id={id} readOnly value={value} className="font-mono text-[12px]" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

export function McpServerInfoDialog({ open, onOpenChange }: McpServerInfoDialogProps) {
  const [info, setInfo] = useState<McpServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    invoke<McpServerInfo>("get_mcp_server_info")
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Claude to this board</DialogTitle>
          <DialogDescription>
            Register this endpoint as an HTTP MCP server. It only works while JiraSync Hub is open.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-destructive text-[13px]">{error}</p>}
        {info && (
          <div className="space-y-3">
            <CopyField id="mcp-url" label="Endpoint URL" value={info.url} />
            <CopyField id="mcp-token" label="Bearer token" value={info.token} />
            <div className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-[11px] break-all">
              claude mcp add --transport http kanban {info.url} --header "Authorization: Bearer{" "}
              {info.token}"
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
