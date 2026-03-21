/**
 * Minimal Electrobun RPC client — direct WebSocket implementation.
 * Does NOT import "electrobun/view" so Vite bundling issues are avoided.
 * Uses the same wire protocol as Electroview: AES-256-GCM encrypted JSON over WS.
 */

const isElectrobun =
  typeof window !== "undefined" &&
  Number.isFinite((window as any).__electrobunRpcSocketPort);

let msgId = 0;
let ws: WebSocket | null = null;
let wsReady = false;
const msgQueue: string[] = [];
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

// Last known frame — seeded from windowGetFrame on connect, updated on setWindowFrame
export let lastKnownFrame = { x: 100, y: 80, width: 1200, height: 800 };

// ── Initialise WebSocket ────────────────────────────────────────────────────
if (isElectrobun) {
  const port = (window as any).__electrobunRpcSocketPort as number;
  const viewId = (window as any).__electrobunWebviewId as number;

  ws = new WebSocket(`ws://localhost:${port}/socket?webviewId=${viewId}`);

  ws.addEventListener("open", () => {
    wsReady = true;
    // Flush queued messages
    const queued = msgQueue.splice(0);
    for (const raw of queued) _sendEncrypted(raw).catch(() => {});
    // Seed the known frame
    _request<typeof lastKnownFrame>("windowGetFrame")
      .then((f) => { if (f) lastKnownFrame = f; })
      .catch(() => {});
  });

  ws.addEventListener("message", async (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const packet = JSON.parse(ev.data);
      const decrypted = await (window as any).__electrobun_decrypt?.(
        packet.encryptedData, packet.iv, packet.tag,
      );
      _handleResponse(JSON.parse(decrypted));
    } catch { /* ignore parse / decrypt errors */ }
  });

  // Also handle responses delivered via evaluateJS (Bun→webview fallback path)
  const _orig = (window as any).__electrobun?.receiveMessageFromBun;
  if ((window as any).__electrobun) {
    (window as any).__electrobun.receiveMessageFromBun = (msg: any) => {
      _handleResponse(msg);
      _orig?.(msg);
    };
  }
}

function _handleResponse(msg: any) {
  if (msg?.type === "response") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.success) p.resolve(msg.payload);
      else p.reject(new Error(msg.error ?? "RPC error"));
    }
  }
}

async function _sendEncrypted(raw: string): Promise<void> {
  if (!ws) return;
  try {
    const enc = await (window as any).__electrobun_encrypt?.(raw);
    if (enc) { ws.send(JSON.stringify(enc)); return; }
  } catch { /* fall through */ }
  // Fallback to native postMessage bridge (unencrypted)
  (window as any).__electrobunBunBridge?.postMessage(raw);
}

function _enqueue(raw: string): void {
  if (wsReady) { _sendEncrypted(raw).catch(() => {}); }
  else { msgQueue.push(raw); }
}

async function _request<T = void>(method: string, params?: unknown): Promise<T | undefined> {
  if (!isElectrobun) return undefined;
  const id = ++msgId;
  const raw = JSON.stringify({ type: "request", id, method, params: params ?? null });
  return new Promise<T | undefined>((resolve, reject) => {
    pending.set(id, { resolve: resolve as any, reject });
    _enqueue(raw);
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve(undefined); }
    }, 10_000);
  });
}

function _send(method: string, params?: unknown): void {
  if (!isElectrobun) return;
  const id = ++msgId;
  _enqueue(JSON.stringify({ type: "request", id, method, params: params ?? null }));
}

// ── Public API ──────────────────────────────────────────────────────────────

export const windowControls = {
  minimize: () => _send("windowMinimize"),
  maximize: () => _send("windowMaximize"),
  close:    () => _send("windowClose"),
};

export function setWindowFrame(x: number, y: number, w: number, h: number): void {
  lastKnownFrame = { x, y, width: w, height: h };
  _send("windowSetFrame", { x, y, width: w, height: h });
}

export function setWindowSize(w: number, h: number): void {
  lastKnownFrame.width = w;
  lastKnownFrame.height = h;
  _send("windowSetSize", { width: w, height: h });
}

export async function getWindowFrame() {
  return _request<typeof lastKnownFrame>("windowGetFrame");
}

/** Proxy a Jira HTTP call through the Bun process (no cookie store → no XSRF). */
export async function bunJiraFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string } | undefined> {
  return _request<{ status: number; body: string }>("jiraFetch", { url, method, headers, body });
}

/** Open a URL in the system default browser (routes via Bun shell). */
export function openExternal(url: string): void {
  if (isElectrobun) {
    _send("openExternal", { url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export const rpcAvailable = () => isElectrobun;

