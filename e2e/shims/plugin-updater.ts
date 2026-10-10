export interface DownloadEvent {
  event: "Started" | "Progress" | "Finished";
}

export interface Update {
  version: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

export async function check(): Promise<Update | null> {
  return null;
}
