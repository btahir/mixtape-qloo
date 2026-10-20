import { mkdir, readFile, writeFile, rename, unlink, appendFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CacheEntry, QlooCache } from "./cache";

/** Opt-in private development cache. No credentials, names or request headers. */
export class DiskCache implements QlooCache {
  constructor(readonly directory: string) {}
  private file(key: string) { return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`); }
  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const item = JSON.parse(await readFile(this.file(key), "utf8"));
      if (item.expires <= Date.now() || typeof item.fetchedAt !== "string" || !("value" in item)) return;
      return { value: item.value, fetchedAt: item.fetchedAt };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return;
      throw e;
    }
  }
  async set(key: string, entry: CacheEntry, ttlMs: number) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(key), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...entry, expires: Date.now() + ttlMs }), { mode: 0o600 });
    await rename(temporary, target);
  }
  async delete(key: string) { await unlink(this.file(key)).catch((e) => { if (e.code !== "ENOENT") throw e; }); }
}

/** Append before dispatch, so failures count too. The run's private ledger survives restarts. */
export async function recordDevelopmentAttempt(directory: string, url: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".attempt-lock"), deadline = Date.now() + 2000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
  const file = join(directory, "attempts.ndjson");
  const lines = await readFile(file, "utf8").catch((e) => { if (e.code === "ENOENT") return ""; throw e; });
  if (lines.trim().split("\n").filter(Boolean).length >= 150) throw new Error("Development Qloo attempt budget reached.");
  const parsed = new URL(url);
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), path: parsed.pathname, queryHash: createHash("sha256").update(parsed.search).digest("hex") }) + "\n", { mode: 0o600 });
  } finally { await rmdir(lock); }
}
