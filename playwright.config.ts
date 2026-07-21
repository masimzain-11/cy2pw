import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./out",
  timeout: 30000,
  use: {
    baseURL: "https://practicesoftwaretesting.com",
    testIdAttribute: "data-test",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
