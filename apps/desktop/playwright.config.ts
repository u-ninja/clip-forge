import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E: runs the real React frontend in Chromium against a mocked Tauri IPC layer
 * (e2e/mock-runtime.ts). These tests prove UI workflows, not the native shell, Rust runtime or
 * process management — those are covered by `cargo test` and the manual native checklist in
 * docs/RUNTIME_LIFECYCLE.md.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://localhost:1420", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
