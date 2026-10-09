// playwright.config.ts
//
// Example configuration for a suite whose results feed playwright-test-history.
// The only hard requirement is the JUnit reporter: triage-report.js reads that
// file after every run and appends it to the build history.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000
  fullyParallel: true,

  // Keep CI honest: never let a stray test.only through.
  forbidOnly: !!process.env.CI,

  // Retry in CI so a single network blip does not turn the build red.
  // Retried tests appear once per attempt in the JUnit file; the triage tool
  // keeps the worst outcome, so a flaky test is still reported as flaky.
  retries: process.env.CI ? 0 : 2,

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "always" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
  ],

  use: {
    baseURL: process.env.BASE_URL || "https://shop.example.com",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"] } },
  ],
});
