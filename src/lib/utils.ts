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

/**
 * Like `Promise.all(items.map(fn))` but never runs more than `limit` calls at once, so a large
 * batch (e.g. one request per Jira issue) cannot trip Jira's rate limiting.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
