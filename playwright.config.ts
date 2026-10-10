import { defineConfig, devices } from "@playwright/test";

const PORT = 1425;
// An explicit IPv4 host: on Linux runners `localhost` can resolve to ::1 while the dev server
// listens on 127.0.0.1 (or the reverse), so the readiness probe would never succeed.
const HOST = "127.0.0.1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /\.e2e\.ts$/,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `bun x --bun vite --mode e2e --host ${HOST} --port ${PORT}`,
    url: `http://${HOST}:${PORT}`,
    stdout: "pipe",
    stderr: "pipe",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 800 } },
    },
  ],
});
