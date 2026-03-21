import {
	BrowserWindow,
	Updater,
	defineElectrobunRPC,
	type ElectrobunRPCSchema,
	type RPCSchema,
} from "electrobun/bun";
import { join } from "path";
import { mkdirSync, readFileSync } from "fs";

interface AppRPCSchema extends ElectrobunRPCSchema {
	bun: RPCSchema<{
		requests: {
			windowMinimize: { params: undefined; response: void };
			windowMaximize: { params: undefined; response: void };
			windowClose: { params: undefined; response: void };
			windowSetFrame: { params: { x: number; y: number; width: number; height: number }; response: void };
			windowSetSize: { params: { width: number; height: number }; response: void };
			windowGetFrame: { params: undefined; response: { x: number; y: number; width: number; height: number } };
			jiraFetch: { params: { url: string; method: string; headers: Record<string, string>; body?: string }; response: { status: number; body: string } };
			openExternal: { params: { url: string }; response: void };
		};
	}>;
	webview: RPCSchema<{ requests: Record<never, never> }>;
}

// ── Window state persistence ────────────────────────────────────────────────
type WindowBounds = { x: number; y: number; width: number; height: number };

const MIN_WIDTH = 1200;
const MIN_HEIGHT = 800;
const DEFAULT_BOUNDS: WindowBounds = { x: 100, y: 80, width: MIN_WIDTH, height: MIN_HEIGHT };

const stateDir = process.env.APPDATA
	? join(process.env.APPDATA, "JiraSyncHub")
	: join(process.env.HOME ?? ".", ".jirasync-hub");
const stateFile = join(stateDir, "window-state.json");

function loadWindowBoundsSync(): WindowBounds {
	try {
		const text = readFileSync(stateFile, "utf-8");
		const saved = JSON.parse(text);
		return {
			x: typeof saved.x === "number" ? saved.x : DEFAULT_BOUNDS.x,
			y: typeof saved.y === "number" ? saved.y : DEFAULT_BOUNDS.y,
			width: Math.max(typeof saved.width === "number" ? saved.width : DEFAULT_BOUNDS.width, MIN_WIDTH),
			height: Math.max(typeof saved.height === "number" ? saved.height : DEFAULT_BOUNDS.height, MIN_HEIGHT),
		};
	} catch {
		return { ...DEFAULT_BOUNDS };
	}
}

async function saveWindowBounds(bounds: WindowBounds): Promise<void> {
	try {
		mkdirSync(stateDir, { recursive: true });
		await Bun.write(stateFile, JSON.stringify(bounds));
	} catch { /* ignore write errors */ }
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
			console.log(
				"Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

const url = await getMainViewUrl();
const initialBounds = loadWindowBoundsSync();

// Declare before RPC so handlers can reference it via closure
let mainWindow: BrowserWindow;

const windowRPC = defineElectrobunRPC<AppRPCSchema, "bun">("bun", {
	handlers: {
		requests: {
			windowMinimize: () => { mainWindow?.minimize(); },
			windowMaximize: () => {
				if (mainWindow?.isMaximized()) mainWindow.unmaximize();
				else mainWindow?.maximize();
			},
			windowClose: () => { mainWindow?.close(); },
			windowSetFrame: ({ x, y, width, height }) => {
				const w = Math.max(width, MIN_WIDTH);
				const h = Math.max(height, MIN_HEIGHT);
				mainWindow?.setFrame(x, y, w, h);
			},
			windowSetSize: ({ width, height }) => {
				const w = Math.max(width, MIN_WIDTH);
				const h = Math.max(height, MIN_HEIGHT);
				mainWindow?.setSize(w, h);
			},
			windowGetFrame: () => mainWindow?.getFrame() ?? { x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT },
			jiraFetch: async ({ url, method, headers, body }) => {
				const res = await fetch(url, {
					method: method || "GET",
					headers,
					body: body || undefined,
				});
				return { status: res.status, body: await res.text() };
			},
			openExternal: ({ url }) => {
				// Validate URL scheme before passing to shell to prevent injection
				if (/^https?:\/\//.test(url)) {
					Bun.spawn(["cmd", "/c", "start", "", url]);
				}
			},
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
mainWindow.on("resize", (event: any) => {
	const { x, y, width, height } = event.data;
	const clampedW = Math.max(width, MIN_WIDTH);
	const clampedH = Math.max(height, MIN_HEIGHT);
	if (clampedW !== width || clampedH !== height) {
		mainWindow.setSize(clampedW, clampedH);
	}
	currentBounds.x = x;
	currentBounds.y = y;
	currentBounds.width = clampedW;
	currentBounds.height = clampedH;
	queueSaveBounds({ ...currentBounds });
});

// Save position on move
mainWindow.on("move", (event: any) => {
	const { x, y } = event.data;
	currentBounds.x = x;
	currentBounds.y = y;
	queueSaveBounds({ ...currentBounds });
});

console.log("JiraSync Hub started!");
