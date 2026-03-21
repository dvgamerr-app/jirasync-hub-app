/**
 * Minimal Electrobun RPC client — direct WebSocket implementation.
 * Does NOT import "electrobun/view" so Vite bundling issues are avoided.
 * Uses the same wire protocol as Electroview: AES-256-GCM encrypted JSON over WS.
 */

type EncryptedPacket = {
  encryptedData: string;
  iv: string;
  tag: string;
};

type RPCResponseMessage =
  | { type: "response"; id: number; success: true; payload: unknown }
  | { type: "response"; id: number; success: false; error?: string };

type ElectrobunBridge = {
  receiveMessageFromBun: (msg: unknown) => void;
};

type ElectrobunMessageBridge = {
  postMessage: (message: string) => void;
};

type ElectrobunRuntimeWindow = Window & {
  __electrobunRpcSocketPort?: number;
  __electrobunWebviewId?: number;
  __electrobun?: ElectrobunBridge;
  __electrobun_encrypt?: (message: string) => Promise<EncryptedPacket>;
  __electrobun_decrypt?: (encryptedData: string, iv: string, tag: string) => Promise<string>;
  __electrobunBunBridge?: ElectrobunMessageBridge;
};

const electrobunWindow =
  typeof window === "undefined" ? undefined : (window as ElectrobunRuntimeWindow);

const isElectrobun = Number.isFinite(electrobunWindow?.__electrobunRpcSocketPort);

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

type RequestArgs<M extends BunRequestName> =
  undefined extends BunRequestParams<M>
    ? [params?: BunRequestParams<M>]
    : [params: BunRequestParams<M>];

let msgId = 0;
let ws: WebSocket | null = null;
let wsReady = false;
const msgQueue: string[] = [];
const pending = new Map<number, PendingRequest>();

// Last known frame — seeded from windowGetFrame on connect, updated on setWindowSize
export let lastKnownFrame: WindowBounds = { x: 100, y: 80, width: 1200, height: 800 };

// ── Initialise WebSocket ────────────────────────────────────────────────────
if (isElectrobun && electrobunWindow) {
  const port = electrobunWindow.__electrobunRpcSocketPort!;
  const viewId = electrobunWindow.__electrobunWebviewId!;

  ws = new WebSocket(`ws://localhost:${port}/socket?webviewId=${viewId}`);

  ws.addEventListener("open", () => {
    wsReady = true;
    // Flush queued messages
    const queued = msgQueue.splice(0);
    for (const raw of queued) _sendEncrypted(raw).catch(() => {});
    // Seed the known frame
    _request("windowGetFrame")
      .then((f) => {
        if (f) lastKnownFrame = f;
      })
      .catch(() => {});
  });

  ws.addEventListener("message", async (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const packet = JSON.parse(ev.data) as Partial<EncryptedPacket>;
      if (
        typeof packet.encryptedData !== "string" ||
        typeof packet.iv !== "string" ||
        typeof packet.tag !== "string"
      ) {
        return;
      }

      const decrypted = await electrobunWindow.__electrobun_decrypt?.(
        packet.encryptedData,
        packet.iv,
        packet.tag,
      );
      if (typeof decrypted !== "string") return;
      _handleResponse(JSON.parse(decrypted));
    } catch {
      /* ignore parse / decrypt errors */
    }
  });

  // Also handle responses delivered via evaluateJS (Bun→webview fallback path)
  const originalReceiveMessageFromBun = electrobunWindow.__electrobun?.receiveMessageFromBun;
  if (electrobunWindow.__electrobun) {
    electrobunWindow.__electrobun.receiveMessageFromBun = (msg: unknown) => {
      _handleResponse(msg);
      originalReceiveMessageFromBun?.(msg);
    };
  }
}

function isRPCResponseMessage(msg: unknown): msg is RPCResponseMessage {
  if (!msg || typeof msg !== "object") return false;

  const response = msg as Partial<RPCResponseMessage>;
  return (
    response.type === "response" &&
    typeof response.id === "number" &&
    typeof response.success === "boolean"
  );
}

function _handleResponse(msg: unknown): void {
  if (!isRPCResponseMessage(msg)) return;

  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    if (msg.success) {
      p.resolve(msg.payload);
      return;
    }

    const errorMessage = "error" in msg ? msg.error : undefined;
    p.reject(new Error(errorMessage ?? "RPC error"));
  }
}

async function _sendEncrypted(raw: string): Promise<void> {
  if (!ws || !electrobunWindow) return;
  try {
    const enc = await electrobunWindow.__electrobun_encrypt?.(raw);
    if (enc) {
      ws.send(JSON.stringify(enc));
      return;
    }
  } catch {
    /* fall through */
  }
  // Fallback to native postMessage bridge (unencrypted)
  electrobunWindow.__electrobunBunBridge?.postMessage(raw);
}

function _enqueue(raw: string): void {
  if (wsReady) {
    _sendEncrypted(raw).catch(() => {});
  } else {
    msgQueue.push(raw);
  }
}

async function _request<M extends BunRequestName>(
  method: M,
  ...args: RequestArgs<M>
): Promise<BunRequestResponse<M> | undefined> {
  if (!isElectrobun) return undefined;
  const id = ++msgId;
  const params = args[0] ?? null;
  const raw = JSON.stringify({ type: "request", id, method, params });
  return new Promise<BunRequestResponse<M> | undefined>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as BunRequestResponse<M>),
      reject,
    });
    _enqueue(raw);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve(undefined);
      }
    }, 10_000);
  });
}

function _send<M extends BunRequestName>(method: M, ...args: RequestArgs<M>): void {
  if (!isElectrobun) return;
  const id = ++msgId;
  const params = args[0] ?? null;
  _enqueue(JSON.stringify({ type: "request", id, method, params }));
}

// ── Public API ──────────────────────────────────────────────────────────────

export const windowControls = {
  minimize: () => _send("windowMinimize"),
  maximize: () => _send("windowMaximize"),
  close: () => _send("windowClose"),
};

export function setWindowSize(w: number, h: number): void {
  const nextSize: BunRequestParams<"windowSetSize"> = { width: w, height: h };
  lastKnownFrame = { ...lastKnownFrame, ...nextSize };
  _send("windowSetSize", nextSize);
}

/** Proxy a Jira HTTP call through the Bun process (no cookie store → no XSRF). */
export async function bunJiraFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<JiraFetchResponse | undefined> {
  return _request("jiraFetch", { url, method, headers, body });
}

/** Open a URL in the system default browser (routes via Bun shell). */
export function openExternal(url: string): void {
  if (isElectrobun) {
    const payload: OpenExternalRequest = { url };
    _send("openExternal", payload);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export const rpcAvailable = () => isElectrobun;
