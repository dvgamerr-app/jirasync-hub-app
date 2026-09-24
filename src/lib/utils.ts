import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Tauri command invocations (e.g. the http plugin's `fetch`) can reject with
 * a bare string or plain object instead of an `Error`, which silently loses
 * the real reason when callers only check `instanceof Error`.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
