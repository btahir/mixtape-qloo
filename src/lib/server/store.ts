import "server-only";
import { kv, type KV } from "@shiptiffin/sdk/kv";
import type { z } from "zod";
import { unavailable, conflict } from "./errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { hosted } from "./deployment";
const deadlines = new AsyncLocalStorage<{ signal: AbortSignal; notAfter: number }>();
export const withStoreDeadline = <T>(signal: AbortSignal, notAfter: number, job: () => Promise<T>) => deadlines.run({ signal, notAfter }, job);
export const withRequestDeadline = <T>(milliseconds: number, job: () => Promise<T>) => withStoreDeadline(AbortSignal.timeout(milliseconds), Date.now() + milliseconds, job);
function bounded(s: Store): Store {
  const context = deadlines.getStore();
  if (!context) return s;
  // Caller waits are bounded even when a transport stalls; database writes also
  // check the deadline atomically before mutation.
  return new Proxy(s, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (!["get", "cas", "batchCas", "del"].includes(String(property))) return value;
    return (...args: unknown[]) => new Promise((resolve, reject) => {
      if (context.signal.aborted) { reject(context.signal.reason); return; }
      const abort = () => reject(context.signal.reason);
      context.signal.addEventListener("abort", abort, { once: true });
      if (property === "cas") args[4] = context.notAfter;
      if (property === "batchCas") args[1] = context.notAfter;
      Promise.resolve(value.apply(target, args)).then(resolve, reject).finally(() => context.signal.removeEventListener("abort", abort));
    });
  } });
}
export interface Write {
  key: string;
  old: string | null;
  value: string;
  ttlMs: number;
}
export interface Store {
  batchCas(writes: Write[], notAfter?: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  cas(
    key: string,
    old: string | null,
    value: string,
    ttlMs: number,
    notAfter?: number,
  ): Promise<boolean>;
  del(key: string): Promise<void>;
}
export class MemoryStore implements Store {
  private data = new Map<string, { value: string; expires: number }>();
  private peek(k: string) {
    const e = this.data.get(k);
    if (!e) return null;
    if (e.expires < Date.now()) {
      this.data.delete(k);
      return null;
    }
    return e.value;
  }
  async get(k: string) {
    return this.peek(k);
  }
  async cas(k: string, old: string | null, value: string, ttlMs: number, notAfter?: number) {
    if (notAfter !== undefined && Date.now() >= notAfter) return false;
    if (this.peek(k) !== old) return false;
    this.data.set(k, { value, expires: Date.now() + ttlMs });
    return true;
  }
  async batchCas(writes: Write[], notAfter?: number) {
    if (notAfter !== undefined && Date.now() >= notAfter) return false;
    if (writes.some((w) => this.peek(w.key) !== w.old)) return false;
    for (const w of writes)
      this.data.set(w.key, { value: w.value, expires: Date.now() + w.ttlMs });
    return true;
  }
  async del(k: string) {
    this.data.delete(k);
  }
}
// Durable records have logical expiry inside a non-expiring KV value, so the
// box cannot evict a gift to make room for cache entries. Expired values are
// treated as absent by the same atomic script as the subsequent write.
export const durableKey = (key: string) => /^(ledger|reservation|run|run-key|limit|draft|index|profile|share|token|receipt|receipt-index|live-sample|comparison|comparison-current|evaluation):/.test(key);
const logicalValue = `local function value(k) local raw=redis.call('GET',k); if not raw then return false end; local e=cjson.decode(raw); local t=redis.call('TIME'); if e.expires<=t[1]*1000+math.floor(t[2]/1000) then return false end; return e.value end; `;
// The final keys hold expiry, ledger presence and atomic durable-size accounting.
const releaseSize = `local function release(k,sizes) local n=tonumber(redis.call('HGET',sizes,k) or '0'); if n>0 then redis.call('HINCRBY',sizes,'__total__',-n); redis.call('HDEL',sizes,k) end end; `;
const transaction = logicalValue + releaseSize + `
local count=#KEYS-3; local gc=KEYS[count+1]; local marker=KEYS[count+2]; local sizes=KEYS[count+3];
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000);
local d=tonumber(ARGV[count*4+1]); if d>0 and now>=d then return 0 end;
for i=1,count do
 local k=KEYS[i]; local v=value(k); local old=ARGV[(i-1)*4+1];
 if string.sub(k,-17)=='mixtape:ledger:v1' and not v and redis.call('EXISTS',marker)==1 then return redis.error_reply('Budget ledger missing') end;
 if not ((not v and old=='__absent__') or v==old) then return 0 end;
end;
local expired=redis.call('ZRANGEBYSCORE',gc,'-inf',now,'LIMIT',0,32);
for _,k in ipairs(expired) do if not value(k) then redis.call('DEL',k); release(k,sizes) end; redis.call('ZREM',gc,k) end;
local delta=0; local additions=0;
for i=1,count do
 local base=(i-1)*4;
 if ARGV[base+4]=='2' then
  local bytes=string.len(ARGV[base+2])+512;
  if bytes>524288 then return redis.error_reply('Durable record too large') end;
  local old=tonumber(redis.call('HGET',sizes,KEYS[i]) or '0');
  delta=delta+bytes-old; if old==0 then additions=additions+1 end;
 end;
end;
local total=tonumber(redis.call('HGET',sizes,'__total__') or '0');
if delta>0 and (total+delta>tonumber(ARGV[count*4+2]) or redis.call('HLEN',sizes)+additions>2001) then return redis.error_reply('Durable storage admission closed') end;
for i=1,count do
 local base=(i-1)*4;
 if ARGV[base+4]=='2' then redis.call('HSET',sizes,KEYS[i],string.len(ARGV[base+2])+512) end;
end;
if delta~=0 then redis.call('HINCRBY',sizes,'__total__',delta) end;
for i=1,count do
 local k=KEYS[i]; local base=(i-1)*4; local ttl=tonumber(ARGV[base+3]);
 local ledger=string.sub(k,-17)=='mixtape:ledger:v1';
 local expires=ledger and 9007199254740991 or now+ttl;
 local raw=cjson.encode({value=ARGV[base+2],expires=expires});
 if ARGV[base+4]~='0' then
  redis.call('SET',k,raw);
  if ledger then redis.call('SET',marker,'1') else redis.call('ZADD',gc,expires,k) end;
 else redis.call('SET',k,raw,'PX',ttl) end;
end; return 1`;
export class RedisStore implements Store {
  constructor(readonly redis: KV, readonly durableBytes = 24 * 1024 * 1024) {}
  private eval(script: string, keys: string[], args: string[]) {
    return this.redis.command("EVAL", script, String(keys.length), ...keys.map((key) => this.redis.key(key)), ...args);
  }
  async get(k: string): Promise<string | null> {
    const raw = await this.redis.get<string>(`mixtape:${k}`);
    if (!raw) {
      if (k === "ledger:v1" && await this.redis.get("mixtape:ledger-initialized")) throw unavailable();
      return null;
    }
    const entry = JSON.parse(raw) as { value: string; expires: number };
    if (entry.expires <= Date.now()) {
      // Delete only the exact expired value; never a concurrent replacement.
      await this.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", [`mixtape:${k}`], [raw]);
      return null;
    }
    return entry.value;
  }
  cas(k: string, old: string | null, value: string, ttlMs: number, notAfter?: number) {
    return this.batchCas([{ key: k, old, value, ttlMs }], notAfter);
  }
  async batchCas(writes: Write[], notAfter?: number) {
    return await this.eval(transaction, [...writes.map((w) => `mixtape:${w.key}`), "mixtape:expiry-index", "mixtape:ledger-initialized", "mixtape:durable-sizes"], [
      ...writes.flatMap((w) => [w.old ?? "__absent__", w.value, String(w.ttlMs), /^(draft|index|profile|share|token|receipt|receipt-index):/.test(w.key) ? "2" : durableKey(w.key) ? "1" : "0"]),
      String(notAfter ?? 0), String(this.durableBytes),
    ]) === 1;
  }
  async del(k: string) {
    await this.eval(releaseSize + "release(KEYS[1],KEYS[3]); redis.call('ZREM',KEYS[2],KEYS[1]); return redis.call('DEL',KEYS[1])", [`mixtape:${k}`, "mixtape:expiry-index", "mixtape:durable-sizes"], []);
  }
}
const globalStore = globalThis as typeof globalThis & { mixtapeStore?: Store };
export function store(): Store {
  if (globalStore.mixtapeStore) return bounded(globalStore.mixtapeStore);
  if (process.env.REDIS_URL)
    return bounded(globalStore.mixtapeStore = new RedisStore(kv({ json: false })));
  // Memory is deliberately local-only, including a locally run production build.
  // A configured platform database must never silently fall back to disposable memory.
  // Mixtape uses durable Valkey records; it needs no Postgres schema.
  if (process.env.DATABASE_URL || hosted() || process.env.REQUIRE_REDIS === "true")
    throw unavailable();
  return bounded(globalStore.mixtapeStore = new MemoryStore());
}
export async function read<T>(
  key: string,
  schema: z.ZodType<T>,
  s = store(),
): Promise<T | null> {
  try {
    const raw = await s.get(key);
    return raw === null ? null : schema.parse(JSON.parse(raw));
  } catch {
    throw unavailable();
  }
}
export async function put<T>(
  key: string,
  schema: z.ZodType<T>,
  value: T,
  ttl: number,
  s = store(),
) {
  const v = schema.parse(value);
  try {
    if (!(await s.cas(key, null, JSON.stringify(v), ttl))) throw conflict();
  } catch (e) {
    if (e instanceof Error && e.message === conflict().message) throw e;
    throw unavailable();
  }
  return v;
}
export async function update<T>(
  key: string,
  schema: z.ZodType<T>,
  fn: (value: T | null) => T,
  ttl: number,
  s = store(),
): Promise<T> {
  for (let i = 0; i < 40; i++) {
    let raw: string | null;
    try {
      raw = await s.get(key);
    } catch {
      throw unavailable();
    }
    const value = fn(raw === null ? null : schema.parse(JSON.parse(raw)));
    const json = JSON.stringify(schema.parse(value));
    if (json.length > 1_500_000) throw unavailable();
    try {
      if (await s.cas(key, raw, json, ttl)) return value;
    } catch {
      throw unavailable();
    }
  }
  throw conflict();
}
export const DAY = 86400000,
  MONTH = 30 * DAY;
