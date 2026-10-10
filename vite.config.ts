import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "path";
import pkg from "./package.json" with { type: "json" };
const host = process.env.TAURI_DEV_HOST;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
// `vite --mode e2e` swaps every Tauri API for a browser shim so Playwright can drive the
// real UI against a fake Jira (see e2e/). These aliases never apply to dev/prod builds.
const e2eShim = (name: string) => path.resolve(rootDir, "e2e/shims", name);
const e2eAliases = {
  "@tauri-apps/api/core": e2eShim("tauri-core.ts"),
  "@tauri-apps/plugin-http": e2eShim("plugin-http.ts"),
  "@tauri-apps/plugin-dialog": e2eShim("plugin-dialog.ts"),
  "@tauri-apps/plugin-fs": e2eShim("plugin-fs.ts"),
  "@tauri-apps/plugin-opener": e2eShim("plugin-opener.ts"),
  "@tauri-apps/plugin-updater": e2eShim("plugin-updater.ts"),
  "@tauri-apps/plugin-process": e2eShim("plugin-process.ts"),
};

export default defineConfig(async ({ mode }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
      ...(mode === "e2e" ? e2eAliases : {}),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (
            id.includes("node_modules/recharts") ||
            id.includes("node_modules/d3-") ||
            id.includes("node_modules/victory-vendor")
          ) {
            return "vendor-charts";
          }
          if (id.includes("node_modules/react-dom")) {
            return "vendor-react-dom";
          }
          if (
            id.includes("node_modules/react") &&
            !id.includes("node_modules/recharts") &&
            !id.includes("node_modules/react-day-picker")
          ) {
            return "vendor-react";
          }
          if (
            id.includes("node_modules/@radix-ui") ||
            id.includes("node_modules/lucide-react") ||
            id.includes("node_modules/cmdk") ||
            id.includes("node_modules/sonner") ||
            id.includes("node_modules/react-day-picker")
          ) {
            return "vendor-ui";
          }
          if (
            id.includes("node_modules/dexie") ||
            id.includes("node_modules/zustand") ||
            id.includes("node_modules/immer")
          ) {
            return "vendor-data";
          }
          if (id.includes("node_modules/@tauri-apps")) {
            return "vendor-tauri";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
