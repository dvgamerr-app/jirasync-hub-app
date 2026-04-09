import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusBadge } from "@/components/StatusBadge";

describe("StatusBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders a dash for null status", async () => {
    await act(async () => {
      root.render(<StatusBadge status={null} />);
    });
    expect(container.textContent).toBe("—");
  });

  it("renders the status text for a known status", async () => {
    await act(async () => {
      root.render(<StatusBadge status="In Progress" />);
    });
    expect(container.textContent).toContain("In Progress");
  });

  it("applies primary colour class for In Progress", async () => {
    await act(async () => {
      root.render(<StatusBadge status="In Progress" />);
    });
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-primary");
  });

  it("applies success colour class for Done", async () => {
    await act(async () => {
      root.render(<StatusBadge status="Done" />);
    });
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-success");
  });

  it("applies muted colour class for To Do", async () => {
    await act(async () => {
      root.render(<StatusBadge status="To Do" />);
    });
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-muted-foreground");
  });

  it("falls back to muted for an unknown status", async () => {
    await act(async () => {
      root.render(<StatusBadge status="Weird Status" />);
    });
    const span = container.querySelector("span");
    expect(span?.className).toContain("text-muted-foreground");
    expect(container.textContent).toContain("Weird Status");
  });

  it("applies truncate classes when truncate prop is true", async () => {
    await act(async () => {
      root.render(<StatusBadge status="In Progress" truncate />);
    });
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("max-w-[7em]");
    const inner = badge?.querySelector("span");
    expect(inner?.className).toContain("truncate");
  });

  it("does not apply truncate classes when truncate is false (default)", async () => {
    await act(async () => {
      root.render(<StatusBadge status="Done" />);
    });
    const badge = container.querySelector("span");
    expect(badge?.className).not.toContain("max-w-[7em]");
  });

  it("works for all known statuses without throwing", async () => {
    const statuses = [
      "To Do", "Backlog", "Open",
      "In Progress", "In Review", "Review",
      "QA", "Testing",
      "Done", "Closed",
    ];
    for (const status of statuses) {
      await act(async () => {
        root.render(<StatusBadge status={status} />);
      });
      expect(container.textContent).toContain(status);
    }
  });

  it("merges extra className with existing classes", async () => {
    await act(async () => {
      root.render(<StatusBadge status="Done" className="my-custom-class" />);
    });
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("my-custom-class");
  });
});
