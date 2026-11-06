// Replaces @tauri-apps/api/event in e2e mode. Tests push native events with
// `window.__e2eEmit(name, payload)` (see helpers.ts `emitRunEvent`).
type Handler = (event: { payload: unknown }) => void;

declare global {
  interface Window {
    __e2eListeners?: Record<string, Handler[]>;
    __e2eEmit?: (name: string, payload: unknown) => void;
  }
}

function listeners(): Record<string, Handler[]> {
  window.__e2eListeners ??= {};
  return window.__e2eListeners;
}

export function emit(name: string, payload: unknown): void {
  for (const handler of [...(listeners()[name] ?? [])]) handler({ payload });
}

window.__e2eEmit = emit;

export async function listen<T>(
  name: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  const list = (listeners()[name] ??= []);
  const wrapped = handler as Handler;
  list.push(wrapped);
  return () => {
    const index = list.indexOf(wrapped);
    if (index >= 0) list.splice(index, 1);
  };
}
