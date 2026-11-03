// Shared in-page state for the e2e shims. Tests read it back via page.evaluate.
import type { DoctorReport, RepoBinding, RepoDetection } from "@/lib/harness";

export interface E2EHarnessState {
  doctor: DoctorReport;
  /** Detection result per folder; a string is the error the native core would return. */
  detections: Record<string, RepoDetection | string>;
  bindings: RepoBinding[];
  /** Every harness command the app invoked, in order. */
  calls: { cmd: string; args?: Record<string, unknown> }[];
}

export interface E2EState {
  /** Files written through the fs shim, keyed by path. */
  files: Record<string, string>;
  /** URLs/paths passed to the opener shim. */
  opened: string[];
  /** Path the dialog shim returns from save(). `null` simulates a cancelled dialog. */
  savePath: string | null;
  /** Folder the dialog shim returns from open(). `null` simulates a cancelled dialog. */
  openPath?: string | null;
  harness?: E2EHarnessState;
}

declare global {
  interface Window {
    __e2e?: E2EState;
  }
}

const tool = (name: string, required: boolean) => ({
  name,
  required,
  purpose: name,
  path: `C:/tools/${name}.exe`,
  version: `${name} 1.0.0`,
  ok: true,
  detail: null,
});

/** All tools working: existing tests that open the AI Board never see the Setup dialog. */
export function readyDoctorReport(): DoctorReport {
  return {
    tools: [tool("git", true), tool("claude", true), tool("gh", true), tool("hurl", false)],
    docker: {
      context: "default",
      endpoint: "npipe:////./pipe/docker_engine",
      serverVersion: "27.0.0",
      ok: true,
      detail: null,
    },
    ready: true,
    checkedAt: 0,
  };
}

export function getE2EState(): E2EState {
  window.__e2e ??= { files: {}, opened: [], savePath: "C:/e2e/export.csv" };
  return window.__e2e;
}

export function getHarnessState(): E2EHarnessState {
  const state = getE2EState();
  state.harness ??= { doctor: readyDoctorReport(), detections: {}, bindings: [], calls: [] };
  return state.harness;
}
