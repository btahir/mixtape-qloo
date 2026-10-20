import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { kv } from "@shiptiffin/sdk/kv";
import { RedisStore } from "@/lib/server/store";
import { reserve, qlooAttempt, ledgerKey, provisionAllowance } from "@/lib/server/limits";

// Opt-in integration regression; isolated local Redis only, no provider access.
it.skipIf(process.env.MIXTAPE_KV_PRESSURE_TEST !== "true")("retains budgets under cache pressure, fails closed on ledger loss, and collects expired durable records", async () => {
  vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true");
  vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
  const port = "16388";
  const child = spawn("redis-server", ["--bind", "127.0.0.1", "--port", port, "--save", "", "--appendonly", "no", "--maxmemory-policy", "volatile-lru"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    const db = kv({ url: `redis://127.0.0.1:${port}`, prefix: "mixtape-r8-test:", json: false });
    const storage = new RedisStore(db);
    await provisionAllowance(storage);
    await reserve("first", "one", true, storage);
    await qlooAttempt(storage);
    expect(await db.command("PTTL", db.key(`mixtape:${ledgerKey}`))).toBe(-1);
    expect(await db.command("PTTL", db.key("mixtape:allowance:v1"))).toBe(-1);
    expect(await db.command("PTTL", db.key("mixtape:reservation:first"))).toBe(-1);
    const used = Number(String(await db.command("INFO", "memory")).match(/used_memory:(\d+)/)![1]);
    await db.command("CONFIG", "SET", "maxmemory", String(used + 1048576));
    for (let i = 0; i < 100; i++) await storage.cas(`cache:pressure-${i}`, null, "x".repeat(20000), 60000);
    // Valkey's LRU is sampled, so a particular oldest key is not guaranteed.
    const cached = await Promise.all(Array.from({ length: 100 }, (_, i) => storage.get(`cache:pressure-${i}`)));
    expect(cached.filter((value) => value === null).length).toBeGreaterThan(0);
    expect(JSON.parse((await storage.get(ledgerKey))!).qlooTotal).toBe(1);
    const ledgerBeforeRedeploy = await storage.get(ledgerKey);
    await provisionAllowance(storage);
    expect(await storage.get(ledgerKey)).toBe(ledgerBeforeRedeploy);
    await db.command("CONFIG", "SET", "maxmemory", "0");
    await reserve("second", "two", true, storage);
    await qlooAttempt(storage);
    const next = JSON.parse((await storage.get(ledgerKey))!);
    expect(next.total).toBe(0.04); expect(next.qlooTotal).toBe(2);
    expect(Object.keys(next.leases)).toEqual(expect.arrayContaining(["first", "second"]));
    await reserve("first", "one", true, storage);
    expect(JSON.parse((await storage.get(ledgerKey))!).total).toBe(0.04);
    for (let i = 0; i < 50; i++) await storage.cas(`run:expired-${i}`, null, "old", 10);
    await new Promise((r) => setTimeout(r, 20));
    await storage.cas("draft:gc-1", null, "ok", 1000);
    await storage.cas("draft:gc-2", null, "ok", 1000);
    expect(await db.command("EXISTS", ...Array.from({ length: 50 }, (_, i) => db.key(`mixtape:run:expired-${i}`)))).toBe(0);
    await storage.del(ledgerKey);
    await expect(reserve("third", "three", true, storage)).rejects.toThrow();
    await expect(storage.cas(ledgerKey, null, "{}", 1000)).rejects.toThrow("Budget ledger missing");
  } finally {
    vi.unstubAllEnvs();
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  }
}, 15000);
