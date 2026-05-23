import "@/test/jsdom-setup";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { LogWorkModal, type LogWorkPayload } from "@/components/LogWorkModal";

const toastMock = mock();

mock.module("@/hooks/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

// Stub heavy UI primitives so they render predictably
mock.module("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

mock.module("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

mock.module("@/components/ui/calendar", () => ({
  Calendar: ({ onSelect }: { onSelect?: (date: Date | undefined) => void }) => (
    <button type="button" onClick={() => onSelect?.(new Date("2026-04-01"))}>
      Pick date
    </button>
  ),
}));

mock.module("@/components/ui/popover", () => ({
  Popover: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) => (
    <div data-open={String(open ?? false)} onClick={() => onOpenChange?.(!open)}>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("LogWorkModal — button variant (default)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onLog: (payload: LogWorkPayload) => void;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onLog = mock<(payload: LogWorkPayload) => void>();

    await act(async () => {
      root.render(<LogWorkModal taskId="task-1" onLog={onLog} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it("renders a Log Time button", () => {
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.some((b) => b.textContent?.includes("Log Time"))).toBe(true);
  });

  it("shows the form content when popover is open", async () => {
    // The outer Popover stub toggles open on click
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Log Time"),
    );
    await act(async () => {
      trigger?.click();
    });
    expect(container.textContent).toContain("Log Work");
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("calls onLog with parsed minutes for a valid time input", async () => {
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Log Time"),
    );
    await act(async () => {
      trigger?.click();
    });

    const input = container.querySelector("input") as HTMLInputElement;

    const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reactProps = propsKey ? (input as any)[propsKey] : {};

    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(input, "1h 30m");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reactProps?.onChange?.({ target: input } as any);
    });

    const logWorkButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Log Work",
    );
    await act(async () => {
      logWorkButton?.click();
    });

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        timeSpentMinutes: 90,
      }),
    );
  });

  it("shows a destructive toast for empty time input", async () => {
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Log Time"),
    );
    await act(async () => {
      trigger?.click();
    });

    const logWorkButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Log Work",
    );
    await act(async () => {
      logWorkButton?.click();
    });

    expect(onLog).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("submits on Enter keydown in the time input", async () => {
    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Log Time"),
    );
    await act(async () => {
      trigger?.click();
    });

    const input = container.querySelector("input") as HTMLInputElement;

    const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reactProps = propsKey ? (input as any)[propsKey] : {};

    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(input, "2h");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reactProps?.onChange?.({ target: input } as any);
    });

    await act(async () => {
      // Re-read props after re-render so onKeyDown closure captures updated timeInput
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentProps = propsKey ? (input as any)[propsKey] : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentProps?.onKeyDown?.({ key: "Enter" } as any);
    });

    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ timeSpentMinutes: 120 }));
  });
});

describe("LogWorkModal — inline variant", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<LogWorkModal taskId="task-2" onLog={mock()} variant="inline" />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it("renders a small plus-icon button instead of the full Log Time button", () => {
    const buttons = Array.from(container.querySelectorAll("button"));
    // Inline variant renders a button with Plus icon, no "Log Time" text
    expect(buttons.some((b) => b.textContent?.includes("Log Time"))).toBe(false);
    expect(buttons.length).toBeGreaterThan(0);
  });
});
