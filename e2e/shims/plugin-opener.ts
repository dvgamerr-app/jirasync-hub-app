import { getE2EState } from "./state";

export async function openUrl(url: string): Promise<void> {
  getE2EState().opened.push(url);
}

export async function openPath(path: string): Promise<void> {
  getE2EState().opened.push(path);
}
