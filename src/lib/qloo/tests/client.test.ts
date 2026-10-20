import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QlooClient,
  QLOO_ORIGIN,
  parseRetryAfter,
  type QlooClientOptions,
} from "../client";
import { MemoryCache, type QlooCache } from "../cache";
import { QlooError } from "../errors";
const valid = { success: true, results: [] };
const json = (
  body: unknown = valid,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const setup = (
  fetcher: typeof fetch,
  options: Partial<QlooClientOptions> = {},
) =>
  new QlooClient({
    origin: QLOO_ORIGIN,
    apiKey: "private-test-key",
    transport: { mode: "live", fetch: fetcher },
    ...options,
  });
const query = { query: "Radiohead" };
const uncached = { cacheTtlMs: 0 };
afterEach(() => vi.useRealTimers());

describe("bounded HTTP behavior", () => {
  it("sends only GET to the fixed origin with header auth and refuses redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json());
    const result = await setup(fetcher).searchEntities(query);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${QLOO_ORIGIN}/search?query=Radiohead`);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Api-Key": "private-test-key", Accept: "application/json" },
    });
    expect(result.provenance).toMatchObject({
      source: "qloo",
      cache: "miss",
      attempts: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private-test-key");
  });
  it.each([429, 500, 502, 503, 504])(
    "retries HTTP %s once with jitter and respects Retry-After",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({}, status, { "retry-after": ".5" }))
        .mockResolvedValueOnce(json());
      const sleeper = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(
        async () => {},
      );
      const result = await setup(fetcher, {
        random: () => 0.5,
        sleep: sleeper,
      }).searchEntities(query, uncached);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result.provenance.attempts).toBe(2);
      expect(sleeper.mock.calls[0]?.[0]).toBe(125); // .5 is not valid Retry-After; full jitter fallback.
    },
  );
  it("respects numeric and date Retry-After without capping it to backoff", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(json());
    const sleeper = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(
      async () => {},
    );
    await setup(fetcher, { sleep: sleeper, maxBackoffMs: 10 }).searchEntities(
      query,
      uncached,
    );
    expect(sleeper.mock.calls[0]?.[0]).toBe(2000);
    expect(
      parseRetryAfter(
        "Sat, 17 Oct 2026 20:00:02 GMT",
        Date.parse("2026-10-17T20:00:00Z"),
      ),
    ).toBe(2000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });
  it("does not retry early when Retry-After exceeds the total budget", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({}, 429, { "retry-after": "120" }),
    );
    const sleeper = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(
      async () => {},
    );
    await expect(
      setup(fetcher, { sleep: sleeper }).searchEntities(query, uncached),
    ).rejects.toMatchObject({ kind: "rate_limit", retryAfterMs: 120000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleeper).not.toHaveBeenCalled();
  });
  it("bounds attempts and exponential backoff", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({}, 503));
    const sleeper = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(
      async () => {},
    );
    await expect(
      setup(fetcher, {
        maxAttempts: 4,
        backoffMs: 250,
        maxBackoffMs: 600,
        random: () => 1,
        sleep: sleeper,
      }).searchEntities(query, uncached),
    ).rejects.toMatchObject({ kind: "upstream", status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleeper.mock.calls.map((c) => c[0])).toEqual([250, 500, 600]);
  });
  it.each([
    [400, "input"],
    [401, "auth"],
    [403, "permission"],
    [404, "not_found"],
  ])("does not retry HTTP %s", async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("upstream secret private-test-key", {
          status: Number(status),
        }),
    );
    await expect(
      setup(fetcher).searchEntities(query, uncached),
    ).rejects.toMatchObject({ kind, status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => json({ success: false, results: [] }),
    () => json({ success: true, results: {} }),
    () =>
      new Response("<html>private-test-key</html>", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response("{invalid json", {
        headers: { "content-type": "application/json" },
      }),
    () =>
      json({ results: [{ entity_id: "guessed", name: "private-test-key" }] }),
  ])(
    "never turns malformed/unsuccessful data into empty success",
    async (response) => {
      const fetcher = vi.fn<typeof fetch>(async () => response());
      let error: unknown;
      try {
        await setup(fetcher).searchEntities(query, uncached);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(QlooError);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error)).not.toContain("private-test-key");
      expect(String(error)).not.toContain("private-test-key");
    },
  );
  it("caps body bytes with and without a Content-Length header", async () => {
    for (const headers of [{}, { "content-length": "1000" }] as Record<
      string,
      string
    >[]) {
      const fetcher = vi.fn<typeof fetch>(async () =>
        json({ results: [], extra: "x".repeat(1000) }, 200, headers),
      );
      await expect(
        setup(fetcher, { maxResponseBytes: 100 }).searchEntities(
          query,
          uncached,
        ),
      ).rejects.toMatchObject({ kind: "contract" });
    }
  });
  it("retries a transient network failure once and sanitizes it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("private-test-key");
    });
    await expect(
      setup(fetcher).searchEntities(query, uncached),
    ).rejects.toMatchObject({
      kind: "network",
      message: "Qloo transport failed.",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("recovers from one transport reset within the same logical operation", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(json());
    const result = await setup(fetcher, { backoffMs: 0 }).searchEntities(query, uncached);
    expect(result.data.results).toEqual([]);
    expect(result.provenance.attempts).toBe(2);
  });
  it("enforces attempt timeout even when a custom fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const result = setup(fetcher, {
      timeoutMs: 30,
      totalDeadlineMs: 100,
    }).searchEntities(query, uncached);
    const rejected = expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(31);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("applies timeout to body streaming, total deadline to cache and backoff", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const result = setup(fetcher, {
      timeoutMs: 30,
      totalDeadlineMs: 100,
    }).searchEntities(query, uncached);
    const rejected = expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(31);
    await rejected;
    const cache: QlooCache = {
      get: () => new Promise(() => {}),
      set: async () => {},
      delete: async () => {},
    };
    const second = setup(fetcher, {
      cache,
      totalDeadlineMs: 20,
    }).searchEntities(query);
    const rejected2 = expect(second).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(21);
    await rejected2;
    const failing = vi.fn<typeof fetch>(async () => json({}, 503));
    const third = setup(failing, {
      totalDeadlineMs: 20,
      backoffMs: 0,
      sleep: () => new Promise(() => {}),
    }).searchEntities(query, uncached);
    const rejected3 = expect(third).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(21);
    await rejected3;
  });
  it("observes bounded error/malformed bodies without letting an observer mutate validated data", async () => {
    const observations: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ code: 403, message: "redact in private recorder" }, 403),
      )
      .mockResolvedValueOnce(
        new Response("{broken", {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(json());
    const c = setup(fetcher, {
      onResponse: (observation) => {
        observations.push(structuredClone(observation));
        if (observation.body && typeof observation.body === "object")
          Object.assign(observation.body, { results: "mutated" });
      },
    });
    await expect(c.searchEntities(query, uncached)).rejects.toMatchObject({
      kind: "permission",
      status: 403,
    });
    await expect(c.searchEntities(query, uncached)).rejects.toMatchObject({
      kind: "contract",
    });
    expect((await c.searchEntities(query, uncached)).data.results).toEqual([]);
    expect(observations).toMatchObject([
      { status: 403, body: { code: 403 } },
      { status: 200, body: "{broken" },
      { status: 200, body: { results: [] } },
    ]);
  });
  it("treats invalid UTF-8 as a contract error", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([0xff]), {
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      setup(fetcher).searchEntities(query, uncached),
    ).rejects.toMatchObject({ kind: "contract" });
  });
  it("rejects invalid local input before making an HTTP call", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json());
    await expect(
      setup(fetcher).searchEntities({ query: "" }),
    ).rejects.toMatchObject({ kind: "input" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects construction and use in browser-like runtimes", async () => {
    vi.stubGlobal("window", {});
    try {
      expect(() => setup(async () => json())).toThrow("server");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("cache and request coalescing", () => {
  it("coalesces concurrent calls and retries, returns isolated copies, then hits cache", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json());
    const c = setup(fetcher, { sleep: async () => {} });
    const [a, b] = await Promise.all([
      c.searchEntities(query),
      c.searchEntities(query),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.data).not.toBe(b.data);
    delete a.data.success; // Mutating caller data must not poison cached copies.
    const cached = await c.searchEntities(query);
    expect(cached.data.success).toBe(true);
    expect(cached.provenance).toMatchObject({ cache: "hit", attempts: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("isolates different API keys and private namespaces in a shared cache", async () => {
    const cache = new MemoryCache();
    const fetcher = vi.fn<typeof fetch>(async () => json());
    for (const [apiKey, cacheNamespace] of [
      ["key-a", "user-a"],
      ["key-b", "user-a"],
      ["key-a", "user-b"],
    ])
      await setup(fetcher, {
        cache,
        apiKey: apiKey!,
        cacheNamespace: cacheNamespace!,
      }).searchEntities(query);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      (
        await setup(fetcher, {
          cache,
          apiKey: "key-a",
          cacheNamespace: "user-a",
        }).searchEntities(query)
      ).provenance.cache,
    ).toBe("hit");
  });
  it("does not cache errors; bypass skips reads and writes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json())
      .mockResolvedValueOnce(json());
    const c = setup(fetcher);
    await expect(c.searchEntities(query)).rejects.toMatchObject({
      kind: "auth",
    });
    expect((await c.searchEntities(query)).provenance.cache).toBe("miss");
    expect((await c.searchEntities(query, uncached)).provenance.cache).toBe(
      "miss",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("expires cached empty results quickly and validates poisoned cache entries", async () => {
    let now = Date.now();
    const cache = new MemoryCache(10, 100000, () => now);
    const fetcher = vi.fn<typeof fetch>(async () => json());
    const c = setup(fetcher, { cache, now: () => now });
    await c.searchEntities(query);
    now += 29999;
    expect((await c.searchEntities(query)).provenance.cache).toBe("hit");
    now += 2;
    expect((await c.searchEntities(query)).provenance.cache).toBe("miss");
    const poisoned: QlooCache = {
      get: async () => ({
        value: { results: {} },
        fetchedAt: new Date(now).toISOString(),
      }),
      set: async () => {},
      delete: vi.fn(async () => {}),
    };
    expect(
      (await setup(fetcher, { cache: poisoned }).searchEntities(query))
        .provenance.cache,
    ).toBe("miss");
    expect(poisoned.delete).toHaveBeenCalled();
  });
  it("fails open on a broken cache adapter", async () => {
    const broken = async () => {
      throw new Error("private-test-key");
    };
    const cache: QlooCache = { get: broken, set: broken, delete: broken };
    expect(
      (await setup(async () => json(), { cache }).searchEntities(query)).data
        .results,
    ).toEqual([]);
  });
  it("cancels one subscriber without aborting another", async () => {
    let release!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const c = setup(fetcher);
    const abort = new AbortController();
    const first = c.searchEntities(query, { signal: abort.signal });
    const second = c.searchEntities(query);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
    abort.abort();
    await rejected;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    release(json());
    expect((await second).data.results).toEqual([]);
  });
  it("aborts upstream when all subscribers cancel and allows a fresh flight", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(async () => json());
    const c = setup(fetcher);
    const abort = new AbortController();
    const first = c.searchEntities(query, { signal: abort.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
    abort.abort();
    const second = c.searchEntities(query);
    await rejected;
    await second;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cancels backoff without issuing another attempt", async () => {
    let entered!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => json({}, 503));
    const c = setup(fetcher, {
      sleep: async () => {
        entered();
        return new Promise(() => {});
      },
    });
    const abort = new AbortController();
    const p = c.searchEntities(query, { signal: abort.signal, cacheTtlMs: 0 });
    await sleeping;
    const rejected = expect(p).rejects.toMatchObject({ kind: "cancelled" });
    abort.abort();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not start work for a pre-aborted caller and bounds unique in-flight calls", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const c = setup(fetcher, { maxInflight: 1 });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      c.searchEntities(query, { signal: aborted.signal }),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
    const abort = new AbortController();
    const first = c.searchEntities(query, { signal: abort.signal });
    await expect(c.searchEntities({ query: "other" })).rejects.toMatchObject({
      kind: "rate_limit",
    });
    const rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
    abort.abort();
    await rejected;
  });
});
