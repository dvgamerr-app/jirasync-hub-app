import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-") || id.includes("node_modules/victory-vendor")) {
            return "vendor-charts";
          }
          if (id.includes("node_modules/react-dom")) {
            return "vendor-react-dom";
          }
          if (id.includes("node_modules/react") && !id.includes("node_modules/recharts") && !id.includes("node_modules/react-resizable-panels") && !id.includes("node_modules/react-day-picker")) {
            return "vendor-react";
          }
          if (id.includes("node_modules/@radix-ui") || id.includes("node_modules/lucide-react") || id.includes("node_modules/cmdk") || id.includes("node_modules/vaul") || id.includes("node_modules/sonner") || id.includes("node_modules/react-resizable-panels") || id.includes("node_modules/react-day-picker") || id.includes("node_modules/embla-carousel") || id.includes("node_modules/input-otp")) {
            return "vendor-ui";
          }
          if (id.includes("node_modules/dexie") || id.includes("node_modules/zustand") || id.includes("node_modules/immer")) {
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
