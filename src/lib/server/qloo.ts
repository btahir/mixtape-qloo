import "server-only";
import { chargeReleaseQloo } from "./release-budget";
import { QlooClient, QLOO_ORIGIN, type QlooFlight } from "../qloo/client";
import { QlooError } from "../qloo/errors";
import { MemoryCache, RedisCache } from "../qloo/cache";
import type { QlooEntity } from "../qloo/schemas";
import type { Entity, Kind } from "../domain";
import { sampleCatalog } from "../samples";
import { acquire, acquireQloo, release, qlooAttempt, ensureQlooAccess } from "./limits";
import { opaque } from "./security";
import { store, RedisStore } from "./store";
import { AppError } from "./errors";
import { entityKind, normalizedId, httpsUrl, description, destination } from "../qloo/normalize";
import { DiskCache, recordDevelopmentAttempt } from "../qloo/disk-cache";
import { hosted } from "./deployment";
import { paceQloo } from "./qloo-pacing";
const memoryCache = new MemoryCache();
const publicSearchFlights = new Map<string, QlooFlight>();
export function projectEntity(
  raw: QlooEntity,
  mode: "live" | "fixture",
  fetchedAt: string,
): Entity | null {
  const kind = entityKind(raw);
  if (!kind) return null;
  const p = raw.properties;
  const year = raw.release_year ?? raw.publication_year ?? p?.release_year ?? p?.publication_year;
  const disambiguation = raw.disambiguation ?? p?.disambiguation;
  const author = raw.author ?? p?.author;
  const detail = disambiguation || [author, year].filter(Boolean).join(" · ");
  const imageUrl = httpsUrl(p?.image?.url ?? raw.image?.url);
  const image = p?.image ?? raw.image;
  const attribution = image && typeof image.attribution === "string" ? image.attribution.slice(0, 200) : undefined;
  return {
    id: normalizedId((raw.entity_id ?? raw.id)!), kind,
    name: raw.name.slice(0, 200),
    detail: detail?.slice(0, 400) || "Details unavailable",
    ...(description(raw) ? { description: description(raw) } : {}),
    ...(imageUrl ? { imageUrl, ...(attribution ? { imageAttribution: attribution } : {}) } : {}),
    ...(destination(raw) ? { destination: destination(raw) } : {}),
    mode, fetchedAt,
  };
}
export function client(scope: string, onAttempt?: () => Promise<void>) {
  ensureQlooAccess();
  if (process.env.QLOO_ORIGIN && process.env.QLOO_ORIGIN !== QLOO_ORIGIN)
    throw new AppError(503, "We cannot reach Qloo with this setup.");
  if (process.env.QLOO_DEV_CACHE_DIR && hosted()) throw new AppError(503, "Development caching is unavailable on public servers.");
  const devDirectory = process.env.QLOO_DEV_CACHE_DIR;
  const s = store();
  const cache =
    s instanceof RedisStore
      ? new RedisCache({
          get: (k) => s.get(`qcache:${k}`),
          setPx: async (k, v, ttl) => {
            const old = await s.get(`qcache:${k}`);
            await s.cas(`qcache:${k}`, old, v, ttl);
          },
          del: (k) => s.del(`qcache:${k}`),
        })
      : memoryCache;
  return new QlooClient({
    origin: QLOO_ORIGIN,
    apiKey: process.env.QLOO_API_KEY,
    isLocalError: (error) => error instanceof AppError,
    cache,
    ...(devDirectory ? { devCache: new DiskCache(devDirectory) } : {}),
    cacheNamespace: `mixtape:live:v2:${scope.startsWith("search:") ? "public-search" : scope}`,
    // Cold selection work belongs to its run; editorial responses still share the cache.
    ...(scope.startsWith("search:") ? { flightPool: publicSearchFlights } : {}),
    maxAttempts: 2,
    transport: {
      mode: "live",
      fetch: async (input, init) => {
        init?.signal?.throwIfAborted();
        const id = opaque();
        await acquireQloo(id, scope, init?.signal ?? AbortSignal.timeout(8000));
        try {
          await paceQloo(init?.signal ?? undefined);
          await onAttempt?.();
          await qlooAttempt();
          init?.signal?.throwIfAborted();
          if (devDirectory) await recordDevelopmentAttempt(devDirectory, String(input));
          chargeReleaseQloo();
          const response = await fetch(input, init);
          let shortThrottle = false;
          // Qloo's observed second-limit responses omit Retry-After. A known
          // remaining monthly allowance distinguishes a short throttle from exhaustion.
          if (response.status === 429 && !response.headers.has("retry-after") &&
            Number(response.headers.get("x-month-ratelimit-remaining")) > 0)
            shortThrottle = true;
          if (!response.body) {
            await release(id);
            const headers = new Headers(response.headers);
            if (shortThrottle) headers.set("retry-after", "1");
            return new Response(null, { status: response.status, headers });
          }
          const reader = response.body.getReader();
          let finished = false;
          const done = async () => {
            if (!finished) {
              finished = true;
              await release(id);
            }
          };
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  await done();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch (error) {
                await done();
                controller.error(error);
              }
            },
            async cancel() {
              try {
                await reader.cancel();
              } finally {
                await done();
              }
            },
          });
          const headers = new Headers(response.headers);
          if (shortThrottle) headers.set("retry-after", "1");
          return new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch (e) {
          await release(id);
          throw e;
        }
      },
    },
  });
}
export async function search(
  query: string,
  kind: Kind,
  mode: "live" | "fixture",
  owner: string,
  signal?: AbortSignal,
) {
  if (mode === "fixture")
    return sampleCatalog
      .filter(
        (e) =>
          e.kind === kind && e.name.toLowerCase().includes(query.toLowerCase()),
      )
      .filter((e, i, all) => all.findIndex((other) => other.name === e.name && other.detail === e.detail) === i)
      .slice(0, 5);
  const id = opaque();
  await acquire("search", id, owner);
  try {
    const r = await client(`search:${owner}`).searchEntities(
      { query, types: [`urn:entity:${kind}`], take: 5, sort_by: "match" },
      { signal, cacheTtlMs: 3600000 },
    );
    return r.data.results
      .map((e) => projectEntity(e, "live", r.provenance.fetchedAt))
      .filter((e): e is Entity => e !== null && e.kind === kind)
      .slice(0, 5);
  } catch (e) {
    if (e instanceof QlooError && e.kind === "not_found") return [];
    throw e;
  } finally {
    await release(id);
  }
}
export function qlooFailure(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && "statusCode" in e && e.statusCode === 402)
    return new AppError(503, "New mixtapes are paused for now. Saved links still work.");
  if (e instanceof QlooError) {
    if (e.kind === "timeout") return new AppError(504, "This is taking longer than it should. Your draft is safe.");
    if (e.kind === "network" || e.kind === "upstream")
      return new AppError(503, "Qloo is unavailable right now. Your current mixtape is still here.");
    if (e.kind === "auth" || e.kind === "permission" || e.kind === "input")
      return new AppError(503, "We cannot reach Qloo with this setup.");
    if (e.kind === "rate_limit")
      return new AppError(
        429,
        e.retryAfterMs
          ? "Qloo needs a short pause. Try again later."
          : "New choices are unavailable right now. You can still open saved mixtapes.",
        e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : undefined,
      );
    if (e.kind === "contract")
      return new AppError(
        503,
        "We could not read Qloo's response. No new choices were saved.",
      );
  }
  return new AppError(
    503,
    "The agent could not finish this mixtape. Your last version is unchanged.",
  );
}
