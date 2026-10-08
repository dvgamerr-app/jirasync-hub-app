// Shared in-page state for the e2e shims. Tests read it back via page.evaluate.
export interface E2EState {
  /** Files written through the fs shim, keyed by path. */
  files: Record<string, string>;
  /** URLs/paths passed to the opener shim. */
  opened: string[];
  /** Path the dialog shim returns from save(). `null` simulates a cancelled dialog. */
  savePath: string | null;
}

declare global {
  interface Window {
    __e2e?: E2EState;
  }
}

export function getE2EState(): E2EState {
  window.__e2e ??= { files: {}, opened: [], savePath: "C:/e2e/export.csv" };
  return window.__e2e;
}
