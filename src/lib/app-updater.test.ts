import "@/test/jsdom-setup";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  AUTO_UPDATE_CHANGED_EVENT,
  AUTO_UPDATE_STORAGE_KEY,
  getAutoUpdateEnabled,
  requestUpdateCheck,
  setAutoUpdateEnabled,
  UPDATE_CHECK_REQUEST_EVENT,
} from "@/lib/app-updater";

describe("app updater preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("enables automatic update checks by default", () => {
    expect(getAutoUpdateEnabled()).toBe(true);
  });

  it("persists the automatic update preference and notifies the app shell", () => {
    const listener = mock((event: Event) => event);
    window.addEventListener(AUTO_UPDATE_CHANGED_EVENT, listener);

    setAutoUpdateEnabled(false);

    expect(localStorage.getItem(AUTO_UPDATE_STORAGE_KEY)).toBe("false");
    expect(getAutoUpdateEnabled()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent<boolean>).detail).toBe(false);

    window.removeEventListener(AUTO_UPDATE_CHANGED_EVENT, listener);
  });

  it("dispatches manual update check requests", () => {
    const listener = mock();
    window.addEventListener(UPDATE_CHECK_REQUEST_EVENT, listener);

    requestUpdateCheck();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(UPDATE_CHECK_REQUEST_EVENT, listener);
  });
});
