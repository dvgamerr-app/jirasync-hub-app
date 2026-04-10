import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

export type WindowResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

type TauriRuntimeWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as TauriRuntimeWindow).__TAURI_INTERNALS__ !== "undefined"
  );
}

export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;

  const platform = `${navigator.platform} ${navigator.userAgent}`;

  return /mac/i.test(platform);
}

export function usesNativeMacTitlebar(): boolean {
  return isMacOS();
}

async function withCurrentWindow(
  action: (window: ReturnType<typeof getCurrentWindow>) => Promise<void>,
): Promise<void> {
  if (!isTauriRuntime()) return;

  try {
    await action(getCurrentWindow());
  } catch {
    // Ignore command failures in plain-browser preview mode.
  }
}

export async function minimizeWindow(): Promise<void> {
  await withCurrentWindow((window) => window.minimize());
}

export async function toggleWindowMaximize(): Promise<void> {
  await withCurrentWindow((window) => window.toggleMaximize());
}

export async function closeWindow(): Promise<void> {
  await withCurrentWindow((window) => window.close());
}

export async function startWindowDragging(): Promise<void> {
  await withCurrentWindow((window) => window.startDragging());
}

export async function startWindowResize(direction: WindowResizeDirection): Promise<void> {
  await withCurrentWindow((window) => window.startResizeDragging(direction));
}

export async function setWindowTheme(isDark: boolean): Promise<void> {
  if (!isTauriRuntime() || !isMacOS()) return;
  try {
    await invoke("set_window_theme", { isDark });
  } catch {
    // Ignore in plain-browser preview mode.
  }
}

export async function openExternal(url: string): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await openUrl(url);
      return;
    }
  } catch {
    // Fall through to the browser fallback.
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
