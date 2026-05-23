// Shared setup for all test files (preload for bun:test, setupFiles for vitest)

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Stub IE-specific event APIs that React's dev build calls unconditionally when
// isInputEventSupported=false. jsdom does not implement these, causing crashes.
if (
  typeof HTMLElement !== "undefined" &&
  !(HTMLElement.prototype as unknown as Record<string, unknown>).attachEvent
) {
  (HTMLElement.prototype as unknown as Record<string, unknown>).attachEvent = () => {};
  (HTMLElement.prototype as unknown as Record<string, unknown>).detachEvent = () => {};
}
