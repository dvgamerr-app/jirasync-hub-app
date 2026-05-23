/// <reference types="vitest/config" />

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Transform bun:test-style test files so vitest can run them:
//   1. Remove `import "@/test/jsdom-setup"` (vitest provides jsdom via environment)
//   2. Replace `mock.module(` → `vi.mock(` so vitest hoists the calls correctly
function bunTestCompatPlugin() {
  return {
    name: "bun-test-compat",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!/\.test\.[jt]sx?$/.test(id)) return null;
      let result = code;
      result = result.replace(/^import\s+["']@\/test\/jsdom-setup["'];?\s*\n?/m, "");
      result = result.replace(/\bmock\.module\(/g, "vi.mock(");
      return { code: result };
    },
  };
}

export default defineConfig({
  plugins: [bunTestCompatPlugin(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "bun:test": path.resolve(__dirname, "src/test/vitest-bun-compat.ts"),
    },
  },
});
