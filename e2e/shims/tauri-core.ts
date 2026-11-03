// Replaces @tauri-apps/api/core in e2e mode. Credentials are "encrypted" with a
// reversible, non-secret encoding so the real encrypt/decrypt call sites still run.
// Harness commands answer from window.__e2e.harness (see state.ts) and record every call.
import type { RepoBinding } from "@/lib/harness";
import { getHarnessState } from "./state";

function harness(cmd: string, args?: Record<string, unknown>): unknown {
  const state = getHarnessState();
  state.calls.push({ cmd, args });
  switch (cmd) {
    case "harness_doctor":
      return state.doctor;
    case "harness_detect_repo": {
      const result = state.detections[String(args?.path)];
      if (result === undefined) throw `${args?.path} is not inside a git repository`;
      if (typeof result === "string") throw result;
      return result;
    }
    case "harness_default_worktree_root":
      return "C:\\wt";
    case "harness_list_bindings":
      return state.bindings;
    case "harness_save_binding": {
      const binding = { ...(args?.binding as RepoBinding), updatedAt: Date.now() };
      state.bindings = [
        ...state.bindings.filter((existing) => existing.projectId !== binding.projectId),
        binding,
      ];
      return binding;
    }
    case "harness_delete_binding":
      state.bindings = state.bindings.filter((binding) => binding.projectId !== args?.projectId);
      return null;
    default:
      return undefined;
  }
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "encrypt_data") return btoa(encodeURIComponent(String(args?.plaintext))) as T;
  if (cmd === "decrypt_data") return decodeURIComponent(atob(String(args?.ciphertext))) as T;
  if (cmd.startsWith("harness_")) return harness(cmd, args) as T;
  throw new Error(`e2e: unmocked tauri command "${cmd}"`);
}
