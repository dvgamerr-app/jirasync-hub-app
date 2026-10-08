import { getE2EState } from "./state";

export async function save(): Promise<string | null> {
  return getE2EState().savePath;
}
