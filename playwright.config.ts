import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4319", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }, { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }],
  webServer: {
    command: "bun --bun next start --hostname 127.0.0.1 --port 4319",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      QLOO_API_KEY: "",
      QLOO_MODE: "fixture",
      ANTHROPIC_API_KEY: "", MIXTAPE_AGENT_MODE: "deterministic",
      
      
      REQUIRE_REDIS: "false",
      // Synthetic forwarded addresses isolate local test clients, with normal caps intact.
      TRUST_PROXY_IP: "true",
      SESSION_SECRET: "local-browser-tests-only-not-a-production-secret",
    },
  },
});
