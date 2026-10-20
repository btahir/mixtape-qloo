import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { samples, comparisonCases } from "../src/lib/samples";
import { installEditorial } from "../src/lib/server/install-editorial";
import { RedisStore, store } from "../src/lib/server/store";

test.skipIf(process.env.MIXTAPE_INSTALL_LIVE !== "true")("privately install and warm reviewed production editorial records", async () => {
  try { process.loadEnvFile(".env.local"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (process.env.QLOO_DEV_CACHE_DIR || !process.env.QLOO_SAMPLE_DIR || !(store() instanceof RedisStore))
    throw new Error("Set QLOO_SAMPLE_DIR and Redis credentials; unset QLOO_DEV_CACHE_DIR. This command writes to the configured Redis.");
  const read = async (name: string) => JSON.parse(await readFile(join(process.env.QLOO_SAMPLE_DIR!, name), "utf8"));
  const manifests = await Promise.all(samples.map((s) => read(`${s.id}.json`)));
  const comparisons = await Promise.all(comparisonCases.map((s) => read(`comparison-${s.id}.json`)));
  const result = await installEditorial(manifests, comparisons);
  expect(result.samples).toBe(3);
  console.log("Installed 3 manifests and 5 saved comparisons atomically; initial rankings warmed with their normal five-minute TTL.");
});
