import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { kv } from "@shiptiffin/sdk/kv";
import { RedisStore } from "@/lib/server/store";
import { counter } from "@/lib/server/limits";
it("closes durable admission atomically while existing gifts and quota writes survive", async () => {
  const child = spawn("redis-server", ["--bind", "127.0.0.1", "--port", "16390", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    const db = kv({ url: "redis://127.0.0.1:16390", prefix: "mixtape-r10:", json: false });
    const storage = new RedisStore(db, 32768);
    await storage.cas("share:original", null, "original gift", 60000);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => storage.cas(`receipt:${i}`, null, "x".repeat(6000), 60000)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    expect(await storage.get("share:original")).toBe("original gift");
    await expect(counter("read:test", 100, 60000, storage)).resolves.toBeDefined();
    await storage.del("receipt:0");
    await expect(storage.cas("receipt:new", null, "x".repeat(6000), 60000)).resolves.toBe(true);
    await expect(storage.batchCas([{ key: "receipt:failed", old: null, value: "x".repeat(6000), ttlMs: 60000 }, { key: "token:failed", old: null, value: "pointer", ttlMs: 60000 }])).rejects.toThrow();
    expect(await storage.get("token:failed")).toBeNull();
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
  }
});
