import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)),
} }, test: { include: ["scripts/prepare-live.test.ts", "scripts/install-live.test.ts"], testTimeout: 120000, maxWorkers: 1 } });
