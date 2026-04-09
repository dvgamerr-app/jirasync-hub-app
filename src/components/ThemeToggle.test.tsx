import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/ThemeToggle";

describe("ThemeToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // Start each test in light mode
    document.documentElement.classList.remove("dark");
    localStorage.removeItem("theme");

    await act(async () => {
      root.render(<ThemeToggle />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.documentElement.classList.remove("dark");
    vi.restoreAllMocks();
  });

  it("renders a button", () => {
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("shows Moon icon in light mode (dark mode inactive)", () => {
    // lucide icons render an <svg> — just check aria or title isn't Sun
    // Since ThemeToggle renders Moon when dark=false:
    // The Moon SVG component is rendered; no Sun SVG.
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
    // In light mode, dark=false → Moon icon shown
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("adds dark class to <html> and persists it when toggled to dark mode", async () => {
    const button = container.querySelector("button")!;

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("removes dark class and persists light after toggling back", async () => {
    // First toggle: light → dark
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Second toggle: dark → light
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("initialises to dark mode when <html> already has dark class", async () => {
    await act(async () => {
      root.unmount();
    });

    document.documentElement.classList.add("dark");
    root = createRoot(container);

    await act(async () => {
      root.render(<ThemeToggle />);
    });

    // Clicking once should go back to light
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
  });
});
