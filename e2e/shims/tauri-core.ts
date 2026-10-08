// Replaces @tauri-apps/api/core in e2e mode. Credentials are "encrypted" with a
// reversible, non-secret encoding so the real encrypt/decrypt call sites still run.
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "encrypt_data") return btoa(encodeURIComponent(String(args?.plaintext))) as T;
  if (cmd === "decrypt_data") return decodeURIComponent(atob(String(args?.ciphertext))) as T;
  throw new Error(`e2e: unmocked tauri command "${cmd}"`);
}
