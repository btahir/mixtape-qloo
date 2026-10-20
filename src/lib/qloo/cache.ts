import { createHash } from "node:crypto";
import { inputError } from "./errors";
import { encodeQuery, type Endpoint, type Query } from "./requests";
import { SCHEMA_VERSION, type ResponseName } from "./schemas";

export interface CacheEntry {
  value: unknown;
  fetchedAt: string;
}
/** Implementations must keep data private and honor TTLs. Exceptions fail open to the API. */
export interface QlooCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}
export class MemoryCache implements QlooCache {
  private readonly entries = new Map<
    string,
    { serialized: string; expires: number; bytes: number }
  >();
  private bytes = 0;
  constructor(
    private readonly maxEntries = 256,
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly now = Date.now,
  ) {
    if (
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1
    )
      throw inputError();
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    const item = this.entries.get(key);
    if (!item) return undefined;
    if (item.expires <= this.now()) {
      await this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, item);
    return JSON.parse(item.serialized) as CacheEntry;
  }
  async set(key: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    await this.delete(key);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const serialized = JSON.stringify(entry);
    const bytes = Buffer.byteLength(serialized) + Buffer.byteLength(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { serialized, bytes, expires: this.now() + ttlMs });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)
      await this.delete(this.entries.keys().next().value!);
  }
  async delete(key: string): Promise<void> {
    const item = this.entries.get(key);
    if (item) this.bytes -= item.bytes;
    this.entries.delete(key);
  }
}
/** Wrap node-redis, ioredis, or a REST client in this deliberately SDK-neutral port. */
export interface RedisPort {
  get(key: string): Promise<string | null>;
  setPx(key: string, serialized: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}
export class RedisCache implements QlooCache {
  constructor(private readonly redis: RedisPort) {}
  async get(key: string): Promise<CacheEntry | undefined> {
    const serialized = await this.redis.get(key);
    if (serialized === null) return undefined;
    const entry: unknown = JSON.parse(serialized);
    if (
      !entry ||
      typeof entry !== "object" ||
      !("value" in entry) ||
      !("fetchedAt" in entry) ||
      typeof entry.fetchedAt !== "string"
    )
      return undefined;
    return entry as CacheEntry;
  }
  async set(key: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    if (ttlMs > 0)
      await this.redis.setPx(key, JSON.stringify(entry), Math.ceil(ttlMs));
  }
  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
/** Hash sensitive query contents; credential scope is already a non-secret hash. */
export function createCacheKey(
  origin: string,
  scope: string,
  endpoint: Endpoint,
  query: Query,
  response: ResponseName,
): string {
  return `qloo:${SCHEMA_VERSION}:${createHash("sha256")
    .update(
      JSON.stringify([origin, scope, endpoint, response, encodeQuery(query)]),
    )
    .digest("hex")}`;
}
