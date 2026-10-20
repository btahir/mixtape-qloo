import { describe, expect, it } from "vitest";
import { encodeQuery, validateQuery } from "../requests";
import {
  createCacheKey,
  MemoryCache,
  RedisCache,
  type RedisPort,
} from "../cache";
import { QlooClient, QLOO_ORIGIN } from "../client";
const id = "f0000000-0000-4000-8000-000000000001";
const key = (
  q: Parameters<typeof encodeQuery>[0],
  scope = "scope",
  endpoint: Parameters<typeof createCacheKey>[2] = "/v2/insights",
) => createCacheKey(QLOO_ORIGIN, scope, endpoint, q, "entityInsights");
describe("query and cache identities", () => {
  it("sorts keys, encodes CSV/dotted keys and retains false/zero", () => {
    expect(
      encodeQuery({
        z: undefined,
        "filter.location.radius": 0,
        "feature.explainability": false,
        a: ["one", "two"],
      }),
    ).toBe("a=one%2Ctwo&feature.explainability=false&filter.location.radius=0");
    expect(key({ b: 2, a: 1 })).toBe(key({ a: 1, b: 2 }));
  });
  it("separates ordered lists, scopes, endpoints, types, pagination and all constraints", () => {
    const queries = [
      {},
      { ids: ["a", "b"] },
      { ids: ["b", "a"] },
      { x: false },
      { x: 0 },
      { radius: 0 },
      { page: 1 },
      { take: 1 },
      { type: "movie" },
      { type: "book" },
      { "filter.tags": ["one"] },
      { "signal.interests.tags": ["one"] },
    ];
    expect(new Set(queries.map((q) => key(q))).size).toBe(queries.length);
    expect(key({})).not.toBe(key({}, "other"));
    expect(key({})).not.toBe(key({}, "scope", "/search"));
    expect(key({ private: "personal taste" })).not.toContain("personal");
  });
  it.each([
    { x: [] },
    { x: NaN },
    { x: Infinity },
    { x: ["a,b"] },
    { x: "" },
    { x: [""] },
  ])("rejects invalid or ambiguous encoding %j", (q) =>
    expect(() => encodeQuery(q)).toThrow(),
  );
  it("rejects arbitrary keys, pagination conflicts, bad ranges and incompatible filters", () => {
    const base = {
      "filter.type": "urn:entity:movie",
      "signal.interests.entities": [id],
    };
    for (const q of [
      { ...base, open_now: true },
      { ...base, page: 1, offset: 0 },
      {
        ...base,
        "filter.release_year.min": 2020,
        "filter.release_year.max": 2010,
      },
      { ...base, "filter.price_level.max": 2 },
      { ...base, "filter.release_date.min": "2026-02-30" },
      { ...base, take: 51 },
      { ...base, "signal.interests.entities": [] },
    ])
      expect(() => validateQuery("/v2/insights", q)).toThrow();
  });
  it("accepts the documented search sort and radius bounds", () => {
    expect(
      validateQuery("/search", {
        query: "Radiohead",
        sort_by: "match",
        "filter.radius": 0,
      }),
    ).toMatchObject({ sort_by: "match", "filter.radius": 0 });
    expect(() =>
      validateQuery("/search", { query: "x", sort_by: "relevance" }),
    ).toThrow();
    expect(() =>
      validateQuery("/search", { query: "x", "filter.radius": 101 }),
    ).toThrow();
  });
  it("requires useful context, demographic seeds and heatmap geometry", () => {
    for (const q of [
      { "filter.type": "urn:entity:movie" },
      {
        "filter.type": "urn:entity:movie",
        "signal.interests.entities.weight": 1,
      },
      { "filter.type": "urn:demographics", "signal.location.query": "Paris" },
      { "filter.type": "urn:heatmap", "signal.interests.entities": [id] },
    ])
      expect(() => validateQuery("/v2/insights", q)).toThrow();
    expect(() =>
      validateQuery("/v2/insights", {
        "filter.type": "urn:heatmap",
        "signal.interests.entities": [id],
        "filter.location.query": "Paris",
        "heatmap.dimensions": ["hotel_class"],
      }),
    ).toThrow();
    expect(
      validateQuery("/v2/insights", {
        "filter.type": "urn:entity:place",
        "signal.interests.entities": [id],
        "filter.location.radius": 0,
        "feature.explainability": false,
      }),
    ).toMatchObject({
      "filter.location.radius": 0,
      "feature.explainability": false,
    });
  });
  it("gates conflicting type aliases explicitly", () => {
    const q = {
      "filter.type": "urn:entity:video_game",
      "signal.interests.entities": [id],
    };
    expect(() => validateQuery("/v2/insights", q)).toThrow();
    expect(validateQuery("/v2/insights", q, true)["filter.type"]).toBe(
      "urn:entity:video_game",
    );
  });
  it("requires two comparison groups and one dated trending seed", () => {
    expect(() =>
      validateQuery("/v2/analysis/compare", {
        "a.signal.interests.entities": [id],
      }),
    ).toThrow();
    expect(() =>
      validateQuery("/v2/trending", {
        "filter.type": "urn:entity:movie",
        "signal.interests.entities": [id, id],
        "filter.start_date": "2026-10-01",
        "filter.end_date": "2026-09-01",
      }),
    ).toThrow();
  });
  it("rejects foreign origins and missing credentials", () => {
    expect(
      () =>
        new QlooClient({
          origin: "https://api.qloo.com" as typeof QLOO_ORIGIN,
          apiKey: "test",
        }),
    ).toThrow();
    expect(() => new QlooClient({ origin: QLOO_ORIGIN })).toThrow();
  });
});
describe("private cache adapters", () => {
  it("honors TTL, LRU entry/byte bounds and defensive copies", async () => {
    let now = 0;
    const cache = new MemoryCache(2, 10000, () => now);
    const entry = {
      value: { name: "original" },
      fetchedAt: new Date(0).toISOString(),
    };
    await cache.set("a", entry, 10);
    entry.value.name = "mutated";
    await cache.set("b", entry, 10);
    const a = await cache.get("a");
    expect(a?.value).toEqual({ name: "original" });
    (a!.value as { name: string }).name = "changed";
    expect((await cache.get("a"))?.value).toEqual({ name: "original" });
    await cache.set("c", entry, 10);
    expect(await cache.get("b")).toBeUndefined();
    now = 10;
    expect(await cache.get("a")).toBeUndefined();
    const tiny = new MemoryCache(2, 1);
    await tiny.set("x", entry, 10);
    expect(await tiny.get("x")).toBeUndefined();
  });
  it("adapts Redis with expiring private serialized entries", async () => {
    let stored: string | null = null;
    let ttl = 0;
    const port: RedisPort = {
      get: async () => stored,
      setPx: async (_key, value, ms) => {
        stored = value;
        ttl = ms;
      },
      del: async () => {
        stored = null;
      },
    };
    const cache = new RedisCache(port);
    const entry = { value: { results: [] }, fetchedAt: "2026-10-17T00:00:00Z" };
    await cache.set("x", entry, 1000);
    expect(ttl).toBe(1000);
    expect(await cache.get("x")).toEqual(entry);
    await cache.delete("x");
    expect(await cache.get("x")).toBeUndefined();
  });
});
