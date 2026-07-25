// Shared setup for all test files (preload for bun:test, setupFiles for vitest)

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

// Node 25+ exposes experimental getter-only storage globals that can resolve
// to undefined. Tests only need standards-compatible in-memory storage.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: createMemoryStorage(),
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: createMemoryStorage(),
});

// Stub IE-specific event APIs that React's dev build calls unconditionally when
// isInputEventSupported=false. jsdom does not implement these, causing crashes.
if (
  typeof HTMLElement !== "undefined" &&
  !(HTMLElement.prototype as unknown as Record<string, unknown>).attachEvent
) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).attachEvent = () => {};
  (HTMLElement.prototype as unknown as Record<string, unknown>).detachEvent = () => {};
}
