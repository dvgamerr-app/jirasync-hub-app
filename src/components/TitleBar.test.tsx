import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "@/components/TitleBar";

const minimizeWindowMock = vi.fn();
const toggleWindowMaximizeMock = vi.fn();
const closeWindowMock = vi.fn();
const startWindowDraggingMock = vi.fn();

vi.mock("@/lib/desktop", () => ({
  minimizeWindow: () => minimizeWindowMock(),
  toggleWindowMaximize: () => toggleWindowMaximizeMock(),
  closeWindow: () => closeWindowMock(),
  startWindowDragging: () => startWindowDraggingMock(),
}));

describe("TitleBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<TitleBar />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders all three window control buttons", () => {
    const minimize = container.querySelector('button[aria-label="Minimize window"]');
    const maximize = container.querySelector('button[aria-label="Toggle maximize window"]');
    const close = container.querySelector('button[aria-label="Close window"]');

    expect(minimize).not.toBeNull();
    expect(maximize).not.toBeNull();
    expect(close).not.toBeNull();
  });

  it("shows the app title", () => {
    expect(container.textContent).toContain("JiraSync Hub");
  });

  it("calls minimizeWindow when Minimize button is clicked", async () => {
    const button = container.querySelector('button[aria-label="Minimize window"]')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(minimizeWindowMock).toHaveBeenCalledOnce();
  });

  it("calls toggleWindowMaximize when Maximize button is clicked", async () => {
    const button = container.querySelector('button[aria-label="Toggle maximize window"]')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggleWindowMaximizeMock).toHaveBeenCalledOnce();
  });

  it("calls closeWindow when Close button is clicked", async () => {
    const button = container.querySelector('button[aria-label="Close window"]')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(closeWindowMock).toHaveBeenCalledOnce();
  });

  it("calls toggleWindowMaximize on double-click in the drag area", async () => {
    // The drag region is the flex-1 div next to the controls
    const dragArea = container.querySelector("div.flex-1") as HTMLElement | null;
    expect(dragArea).not.toBeNull();

    await act(async () => {
      dragArea?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 2 }),
      );
    });

    expect(toggleWindowMaximizeMock).toHaveBeenCalledOnce();
    expect(startWindowDraggingMock).not.toHaveBeenCalled();
  });

  it("calls startWindowDragging on single left-click in the drag area", async () => {
    const dragArea = container.querySelector("div.flex-1") as HTMLElement | null;

    await act(async () => {
      dragArea?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }),
      );
    });

    expect(startWindowDraggingMock).toHaveBeenCalledOnce();
    expect(toggleWindowMaximizeMock).not.toHaveBeenCalled();
  });

  it("ignores non-left mouse button in the drag area", async () => {
    const dragArea = container.querySelector("div.flex-1") as HTMLElement | null;

    await act(async () => {
      dragArea?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 2, detail: 1 }),
      );
    });

    expect(startWindowDraggingMock).not.toHaveBeenCalled();
    expect(toggleWindowMaximizeMock).not.toHaveBeenCalled();
  });
});
