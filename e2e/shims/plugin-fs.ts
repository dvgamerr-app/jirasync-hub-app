import { getE2EState } from "./state";

export async function writeTextFile(path: string, data: string): Promise<void> {
  getE2EState().files[path] = data;
}
