// Sets up jsdom globals for component tests when bun runs with --isolate
// Each test file imports this to get a fresh DOM environment
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
const { window: win } = dom;

Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  location: win.location,
  history: win.history,
  screen: win.screen,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLDivElement: win.HTMLDivElement,
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLFormElement: win.HTMLFormElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement,
  HTMLLabelElement: win.HTMLLabelElement,
  Node: win.Node,
  NodeList: win.NodeList,
  Element: win.Element,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  FocusEvent: win.FocusEvent,
  MutationObserver: win.MutationObserver,
  ResizeObserver:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win as any).ResizeObserver ??
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  DocumentFragment: win.DocumentFragment,
  Text: win.Text,
  Comment: win.Comment,
  Range: win.Range,
  SVGElement: win.SVGElement,
  HTMLAnchorElement: win.HTMLAnchorElement,
  HTMLSelectElement: win.HTMLSelectElement,
  HTMLSpanElement: win.HTMLSpanElement,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CustomEvent: (win as any).CustomEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
  cancelAnimationFrame: clearTimeout,
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Stub IE-specific event APIs that React's dev build tries to use as polyfills.
// React's handleEventsForInputEventPolyfill calls element.attachEvent() unconditionally
// when isInputEventSupported=false. Adding no-op stubs prevents crashes in jsdom.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(win.HTMLElement.prototype as any).attachEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (win.HTMLElement.prototype as any).attachEvent = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (win.HTMLElement.prototype as any).detachEvent = () => {};
}

if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
