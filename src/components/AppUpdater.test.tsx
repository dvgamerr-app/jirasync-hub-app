import "@/test/jsdom-setup";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, mock, jest } from "bun:test";
import { AppUpdater } from "@/components/AppUpdater";
import { requestUpdateCheck, setAutoUpdateEnabled } from "@/lib/app-updater";

interface UpdaterMocks {
  download: ReturnType<typeof mock>;
  install: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  check: ReturnType<typeof mock>;
}

// `var` is intentional: module mock factories are hoisted by Vitest.
// eslint-disable-next-line no-var
var updaterMocks: UpdaterMocks;
// eslint-disable-next-line no-var
var relaunchMock: ReturnType<typeof mock>;

mock.module("@tauri-apps/plugin-updater", () => {
  const download = mock(
    async (
      onEvent?: (
        event:
          | { event: "Started"; data: { contentLength?: number } }
          | { event: "Progress"; data: { chunkLength: number } }
          | { event: "Finished" },
      ) => void,
    ) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    },
  );
  const install = mock(async () => {});
  const close = mock(async () => {});
  const check = mock(async () => ({
    version: "0.7.0",
    body: `### Bug Fixes

- Repair updated CI workflows ([\`63e28ef\`](https://github.com/$GITHUB_REPOSITORY/commit/63e28ef))`,
    download,
    install,
    close,
  }));

  updaterMocks = { download, install, close, check };
  return { check };
});

mock.module("@tauri-apps/plugin-process", () => {
  relaunchMock = mock(async () => {});
  return { relaunch: relaunchMock };
});

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AppUpdater", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    localStorage.clear();
    setAutoUpdateEnabled(false);
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<AppUpdater />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    jest.clearAllMocks();
  });

  it("checks manually, downloads on Windows, and waits for restart before installing", async () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Win32",
    });

    await act(async () => {
      requestUpdateCheck();
      await flush();
    });

    expect(container.textContent).toContain("Version 0.7.0 is available");
    expect(container.textContent).toContain("Bug Fixes");
    expect(container.textContent).not.toContain("###");
    expect(container.querySelector("h3")?.textContent).toBe("Bug Fixes");
    expect(container.querySelector("li")?.textContent).toContain("Repair updated CI workflows");
    expect(container.querySelector("code")?.textContent).toBe("63e28ef");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/dvgamerr-app/jirasync-hub-app/commit/63e28ef",
    );

    await act(async () => {
      findButton(container, "Update now")?.click();
      await flush();
    });

    expect(updaterMocks.download).toHaveBeenCalledTimes(1);
    expect(updaterMocks.install).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Ready to restart and update");

    await act(async () => {
      findButton(container, "Restart to update")?.click();
      await flush();
    });

    expect(updaterMocks.install).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });

  it("installs before offering restart on macOS and Linux", async () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });

    await act(async () => {
      requestUpdateCheck();
      await flush();
    });

    await act(async () => {
      findButton(container, "Update now")?.click();
      await flush();
    });

    expect(updaterMocks.install).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Update installed");
    expect(findButton(container, "Restart now")).toBeDefined();
  });
});
