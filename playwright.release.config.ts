import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

export default defineConfig({
  testDir: "./tests/release-browser",
  outputDir: "test-results/release",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 45000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4321" },
  webServer: {
    command: "bun --bun next start --hostname 127.0.0.1 --port 4321",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      APP_ORIGIN: "http://127.0.0.1:4321",
      PUBLIC_DEMO: "false",
      TIFFIN_URL: "",
      TIFFIN_PROJECT: "",
      QLOO_MODE: "live",
      QLOO_DEV_CACHE_DIR: "",
      // bun run release must already have installed the test Valkey records.
      QLOO_SAMPLE_DIR: ".qa/no-file-fallback",
      MIXTAPE_AGENT_MODE: "anthropic",
      REQUIRE_REDIS: "true",
      TRUST_PROXY_IP: "true",
      SESSION_SECRET: randomBytes(32).toString("hex"),
    },
  },
});
