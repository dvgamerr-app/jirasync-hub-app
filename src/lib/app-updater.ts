export const AUTO_UPDATE_STORAGE_KEY = "app-auto-update-enabled";
export const UPDATE_CHECK_REQUEST_EVENT = "app-update-check-requested";
export const AUTO_UPDATE_CHANGED_EVENT = "app-auto-update-changed";

export function getAutoUpdateEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;

  try {
    return localStorage.getItem(AUTO_UPDATE_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_UPDATE_STORAGE_KEY, String(enabled));
  } catch {
    // Keep the in-memory setting usable when storage is unavailable.
  }

  window.dispatchEvent(new CustomEvent<boolean>(AUTO_UPDATE_CHANGED_EVENT, { detail: enabled }));
}

export function requestUpdateCheck(): void {
  window.dispatchEvent(new Event(UPDATE_CHECK_REQUEST_EVENT));
}
