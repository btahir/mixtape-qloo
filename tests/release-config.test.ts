import { afterEach, expect, it, vi } from "vitest";
import { hosted } from "@/lib/server/deployment";
import { MemoryStore, store } from "@/lib/server/store";
import { ledgerKey, qlooAttempt, reserve } from "@/lib/server/limits";

afterEach(() => vi.unstubAllEnvs());

it("empty optional budget entries retain defaults, while explicit zero stops spend", async () => {
  vi.stubEnv("MODEL_DAILY_CAP_USD", "");
  vi.stubEnv("MODEL_TOTAL_CAP_USD", "");
  vi.stubEnv("QLOO_DAILY_ATTEMPTS", "");
  vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "");
  vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true");
  vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
  const storage = new MemoryStore();
  await reserve("first", "reader", true, storage);
  await qlooAttempt(storage);
  expect(JSON.parse((await storage.get(ledgerKey))!).qlooTotal).toBe(1);
  vi.stubEnv("MODEL_DAILY_CAP_USD", "0");
  await expect(reserve("second", "reader", true, storage)).rejects.toThrow();
});

it("recognizes the documented Tiffin URL as hosted without an explicit app origin", () => {
  vi.stubEnv("TIFFIN_URL", "https://mixtape.example.com");
  expect(hosted()).toBe(true);
});

it("never silently uses disposable memory when only a platform database is configured", () => {
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/mixtape");
  expect(() => store()).toThrow();
});
