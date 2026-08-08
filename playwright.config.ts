import { defineConfig, devices } from "@playwright/test";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: "html",
  retries: process.env.CI ? 2 : 0,
  testDir: "./src/tests/e2e",
  use: {
    trace: "on-first-retry",
  },
  // Always one worker: each spec launches a full Electron app and drives git
  // against its own repository. Running them side by side makes them contend
  // for CPU and produces timing flakes that say nothing about the code.
  workers: 1,
});
