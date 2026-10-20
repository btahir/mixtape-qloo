import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/live-browser", outputDir: ".qa/live-results", expect: { timeout: 45000 }, fullyParallel: false, workers: 2, reporter: "list",
  use: { baseURL: "http://127.0.0.1:4320", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "bun --bun next start --hostname 127.0.0.1 --port 4320", url: "http://127.0.0.1:4320", reuseExistingServer: false, timeout: 30000,
    env: { QLOO_MODE: "live", QLOO_DEV_CACHE_DIR: process.env.QLOO_DEV_CACHE_DIR || "", MIXTAPE_AGENT_MODE: process.env.MIXTAPE_LIVE_AGENT || "anthropic",   REQUIRE_REDIS: "false", TRUST_PROXY_IP: "true", SESSION_SECRET: "local-browser-tests-only-not-a-production-secret" },
  },
});
