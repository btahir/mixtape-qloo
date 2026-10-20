import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryStore, DAY } from "@/lib/server/store";
import { ledgerKey, provisionAllowance, qlooAttempt, quotaDefaults, reserve } from "@/lib/server/limits";
import { runRelease } from "@/lib/server/release";
import { chargeReleaseModel, chargeReleaseQloo, withReleaseBudget } from "@/lib/server/release-budget";
import { ipKey } from "@/lib/server/security";
import { verifyDeployment } from "@/lib/server/deployment";

beforeEach(() => {
  for (const key of ["TIFFIN_URL", "TIFFIN_PROJECT", "PUBLIC_DEMO", "APP_ORIGIN", "QLOO_DAILY_ATTEMPTS", "QLOO_TOTAL_ATTEMPTS", "QLOO_QUOTA_RESET_AT", "QLOO_ACCESS_EXPIRES_AT", "QLOO_EVENT_ACCESS_CONFIRMED", "QLOO_ALLOCATION_CONFIRMED", "MODEL_DAILY_CAP_USD", "MODEL_TOTAL_CAP_USD", "PAUSE_GENERATION", "TRUST_PROXY_IP", "INGRESS_VERIFIED"]) vi.stubEnv(key, "");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("provisions defaults atomically and redeploys never overwrite live counters or allowances", async () => {
  const s = new MemoryStore();
  await Promise.all([provisionAllowance(s), provisionAllowance(s)]);
  expect(JSON.parse((await s.get("allowance:v1"))!)).toEqual(quotaDefaults());
  await qlooAttempt(s); await reserve("paid", "visitor", true, s);
  const before = await s.get(ledgerKey), allocation = await s.get("allowance:v1");
  vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "100");
  await runRelease(s, async () => {});
  expect(await s.get(ledgerKey)).toBe(before);
  expect(await s.get("allowance:v1")).toBe(allocation);
});
it("resets the project Qloo allowance once on November 18, without resetting model spend", async () => {
  const s = new MemoryStore();
  await provisionAllowance(s); await qlooAttempt(s); await reserve("paid", "visitor", true, s);
  vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
  await qlooAttempt(s); await qlooAttempt(s); await provisionAllowance(s);
  expect(JSON.parse((await s.get(ledgerKey))!)).toMatchObject({ qlooTotal: 2, qlooDaily: 2, total: .02, qlooResetApplied: "2026-11-18T00:00:00Z" });
});
it("honors lower configured allowances and explicit expiry/disable switches", async () => {
  const s = new MemoryStore();
  vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "1"); await provisionAllowance(s);
  vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "2500");
  await qlooAttempt(s); await expect(qlooAttempt(s)).rejects.toThrow();
  vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "false"); await expect(qlooAttempt(new MemoryStore())).rejects.toThrow();
  vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", ""); vi.setSystemTime(new Date("2026-12-01"));
  await expect(qlooAttempt(new MemoryStore())).rejects.toThrow();
});
it("caps concurrent dispatches at 30 Qloo attempts and $0.10 of conservative model cost", async () => {
  const budget = { qloo: 0, modelMicroUsd: 0, deadline: Date.now() + DAY };
  await withReleaseBudget(budget, async () => {
    const q = await Promise.allSettled(Array.from({ length: 40 }, async () => chargeReleaseQloo()));
    expect(q.filter((r) => r.status === "fulfilled")).toHaveLength(30);
    const model = await Promise.allSettled(Array.from({ length: 80 }, async () => chargeReleaseModel("claude-haiku-5-5", 8000)));
    expect(model.filter((r) => r.status === "fulfilled")).toHaveLength(66);
    expect(budget.modelMicroUsd).toBe(99792);
    expect(() => chargeReleaseModel("other-model", 100)).toThrow();
    expect(() => chargeReleaseModel("claude-haiku-5-5", 8001)).toThrow();
  });
});
it("warming errors do not fail a release, while provisioning failures do", async () => {
  const s = new MemoryStore();
  const report = await runRelease(s, async () => { chargeReleaseQloo(); throw new Error("provider secret must not escape"); });
  expect(report.unavailable).toEqual(["warming-unavailable"]);
  expect(report.budget.qloo).toBe(1);
  expect(await s.get("live-sample:quiet-evenings")).toBeNull();
  const broken = new MemoryStore(); vi.spyOn(broken, "cas").mockRejectedValue(new Error("storage unavailable"));
  await expect(runRelease(broken)).rejects.toThrow("storage unavailable");
});
it("only one simultaneous release warms", async () => {
  const s = new MemoryStore(); let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const warm = vi.fn(async () => pending);
  const first = runRelease(s, warm);
  await vi.waitFor(async () => expect(await s.get("release:warm-lock")).not.toBeNull());
  const second = await runRelease(s, warm);
  expect(second.unavailable).toContain("warming-already-running");
  finish(); await first; expect(warm).toHaveBeenCalledTimes(1);
});
it("Tiffin enables public checks and uses the last XFF hop, ignoring spoofed prefixes", () => {
  vi.stubEnv("TIFFIN_URL", "https://mixtape.example.com");
  vi.stubEnv("APP_ORIGIN", "https://mixtape.example.com");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("SESSION_SECRET", "test-only-session-secret-32-characters");
  expect(() => verifyDeployment()).not.toThrow();
  const req = (ip: string) => new Request("https://mixtape.example.com", { headers: { "x-forwarded-for": ip } });
  expect(ipKey(req("198.51.100.1, 203.0.113.2"))).toBe(ipKey(req("203.0.113.2")));
  expect(ipKey(req("spoof, 203.0.113.2"))).toBe(ipKey(req("203.0.113.2")));
  expect(ipKey(req("203.0.113.3"))).not.toBe(ipKey(req("203.0.113.2")));
  expect(() => ipKey(req("203.0.113.2, invalid"))).toThrow();
  vi.stubEnv("TRUST_PROXY_IP", "false"); expect(() => verifyDeployment()).toThrow();
});
