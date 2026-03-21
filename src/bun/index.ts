import { BrowserWindow, Updater, defineElectrobunRPC } from "electrobun/bun";
import { join } from "path";
import { mkdirSync, readFileSync } from "fs";

// ── Window state persistence ────────────────────────────────────────────────
type WindowPosition = Pick<WindowBounds, "x" | "y">;

const MIN_WIDTH = 1200;
const MIN_HEIGHT = 800;
const DEFAULT_BOUNDS: WindowBounds = { x: 100, y: 80, width: MIN_WIDTH, height: MIN_HEIGHT };
const FALLBACK_BOUNDS: WindowBounds = { x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT };
const EXTERNAL_URL_RE = /^https?:\/\//i;

function clampWindowSize({ width, height }: WindowSize): WindowSize {
  return {
    width: Math.max(width, MIN_WIDTH),
    height: Math.max(height, MIN_HEIGHT),
  };
}

function normalizeWindowBounds(value: unknown): WindowBounds {
  const saved = typeof value === "object" && value !== null ? (value as Partial<WindowBounds>) : {};
  const { width, height } = clampWindowSize({
    width: typeof saved.width === "number" ? saved.width : DEFAULT_BOUNDS.width,
    height: typeof saved.height === "number" ? saved.height : DEFAULT_BOUNDS.height,
  });

  return {
    x: typeof saved.x === "number" ? saved.x : DEFAULT_BOUNDS.x,
    y: typeof saved.y === "number" ? saved.y : DEFAULT_BOUNDS.y,
    width,
    height,
  };
}

function getEventData(event: unknown): unknown {
  if (typeof event !== "object" || event === null || !("data" in event)) {
    return undefined;
  }

  return (event as { data?: unknown }).data;
}

function readWindowPosition(value: unknown): WindowPosition | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const payload = value as Partial<WindowPosition>;
  if (typeof payload.x !== "number" || typeof payload.y !== "number") {
    return null;
  }

  return { x: payload.x, y: payload.y };
}

function readWindowBounds(value: unknown): WindowBounds | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const payload = value as Partial<WindowBounds>;
  if (
    typeof payload.x !== "number" ||
    typeof payload.y !== "number" ||
    typeof payload.width !== "number" ||
    typeof payload.height !== "number"
  ) {
    return null;
  }

  return {
    x: payload.x,
    y: payload.y,
    width: payload.width,
    height: payload.height,
  };
}

const stateDir = process.env.APPDATA
  ? join(process.env.APPDATA, "JiraSyncHub")
  : join(process.env.HOME ?? ".", ".jirasync-hub");
const stateFile = join(stateDir, "window-state.json");

function loadWindowBoundsSync(): WindowBounds {
  try {
    const text = readFileSync(stateFile, "utf-8");
    return normalizeWindowBounds(JSON.parse(text));
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

async function saveWindowBounds(bounds: WindowBounds): Promise<void> {
  try {
    mkdirSync(stateDir, { recursive: true });
    await Bun.write(stateFile, JSON.stringify(bounds));
  } catch {
    /* ignore write errors */
  }
}

let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
function queueSaveBounds(bounds: WindowBounds) {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveWindowBounds(bounds).catch(() => {});
    saveBoundsTimer = null;
  }, 500);
}

// ── App startup ─────────────────────────────────────────────────────────────
const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
      return DEV_SERVER_URL;
    } catch {
      console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.");
    }
  }
  return "views://mainview/index.html";
}

const url = await getMainViewUrl();
const initialBounds = loadWindowBoundsSync();

// Declare before RPC so handlers can reference it via closure
let mainWindow: BrowserWindow | null = null;

function setClampedWindowSize(size: WindowSize): void {
  const { width, height } = clampWindowSize(size);
  mainWindow?.setSize(width, height);
}

async function handleJiraFetch({
  url,
  method = "GET",
  headers,
  body,
}: JiraFetchRequest): Promise<JiraFetchResponse> {
  if (typeof url !== "string" || url.trim() === "") {
    return { status: 400, body: "Missing or invalid url" };
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
  });

  return { status: res.status, body: await res.text() };
}

function handleOpenExternal({ url }: OpenExternalRequest): void {
  // Validate URL scheme before passing to shell to prevent injection
  if (EXTERNAL_URL_RE.test(url)) {
    Bun.spawn(["cmd", "/c", "start", "", url]);
  }
}

const windowRPC = defineElectrobunRPC<AppRPCSchema, "bun">("bun", {
  handlers: {
    requests: {
      windowMinimize: () => {
        mainWindow?.minimize();
      },
      windowMaximize: () => {
        if (mainWindow?.isMaximized()) mainWindow.unmaximize();
        else mainWindow?.maximize();
      },
      windowClose: () => {
        mainWindow?.close();
      },
      windowSetSize: setClampedWindowSize,
      windowGetFrame: () => mainWindow?.getFrame() ?? FALLBACK_BOUNDS,
      jiraFetch: handleJiraFetch,
      openExternal: handleOpenExternal,
    },
  },
});

mainWindow = new BrowserWindow({
  title: "JiraSync Hub",
  url,
  titleBarStyle: "hidden",
  frame: initialBounds,
  rpc: windowRPC,
});

// Track current bounds for move events
const currentBounds: WindowBounds = { ...initialBounds };

// Enforce minimum size and save on resize
mainWindow.on("resize", (event) => {
  const bounds = readWindowBounds(getEventData(event));
  if (!bounds) return;

  const { x, y, width, height } = bounds;
  const clampedSize = clampWindowSize({ width, height });
  if (clampedSize.width !== width || clampedSize.height !== height) {
    mainWindow?.setSize(clampedSize.width, clampedSize.height);
  }
  currentBounds.x = x;
  currentBounds.y = y;
  currentBounds.width = clampedSize.width;
  currentBounds.height = clampedSize.height;
  queueSaveBounds({ ...currentBounds });
});

// Save position on move
mainWindow.on("move", (event) => {
  const position = readWindowPosition(getEventData(event));
  if (!position) return;

  const { x, y } = position;
  currentBounds.x = x;
  currentBounds.y = y;
  queueSaveBounds({ ...currentBounds });
});

console.log("JiraSync Hub started!");
