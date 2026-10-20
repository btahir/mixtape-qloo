import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MemoryCache,
  createCacheKey,
  type CacheEntry,
  type QlooCache,
} from "./cache";
import { QlooError, assertServer, cancelledError, inputError } from "./errors";
import {
  encodeQuery,
  validateQuery,
  type Endpoint,
  type Query,
  type SearchRequest,
  type EntitiesRequest,
  type InsightsRequest,
  type TagsRequest,
  type TagTypesRequest,
  type CompareRequest,
  type TrendingRequest,
} from "./requests";
import {
  responseSchemas,
  insightsResponseName,
  type InsightsType,
  type InsightsResponse,
  type ResponseName,
  type ResponseFor,
} from "./schemas";

assertServer();
export const QLOO_ORIGIN = "https://hackathon.api.qloo.com";
export interface QlooTransport {
  readonly mode: "live" | "fixture";
  fetch: typeof globalThis.fetch;
}
export interface RequestOptions {
  signal?: AbortSignal;
  cacheTtlMs?: number;
}
export interface QlooResult<T> {
  data: T;
  provenance: {
    source: "qloo" | "fixture";
    cache: "hit" | "miss";
    fetchedAt: string;
    elapsedMs: number;
    attempts: number;
    endpoint: Endpoint;
  };
}
export interface ResponseObservation {
  endpoint: Endpoint;
  responseName: ResponseName;
  status: number;
  body: unknown;
}
export interface QlooClientOptions {
  apiKey?: string | undefined;
  isLocalError?: (error: unknown) => boolean;
  /** Explicit origin; there is no production/staging fallback. */
  origin: typeof QLOO_ORIGIN;
  transport?: QlooTransport;
  cache?: QlooCache;
  /** Local development only: canonical method/path/params cache shared across test sessions. */
  devCache?: QlooCache;
  /** Private tenant/user scope. Credential isolation is added automatically. */
  cacheNamespace?: string;
  timeoutMs?: number;
  totalDeadlineMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  maxResponseBytes?: number;
  maxInflight?: number;
  /** Share only across callers using the same validated transport/policy. */
  flightPool?: Map<string, QlooFlight>;
  /** Opt in to docs-conflicted destination/locality/video_game spellings. No automatic aliases. */
  allowCompatibilityTypes?: boolean;
  /** Private diagnostic hook, called before schema parsing, including contract failures. */
  onResponse?: (observation: ResponseObservation) => void | Promise<void>;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface QlooFlight {
  controller: AbortController;
  promise: Promise<QlooResult<unknown>>;
  subscribers: number;
}

function abortReason(signal: AbortSignal): QlooError {
  return signal.reason instanceof QlooError ? signal.reason : cancelledError();
}
/** All waits, including adapters and custom transports, are covered by deadlines. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function parseRetryAfter(
  value: string | null,
  now: number,
): number | undefined {
  if (value === null || !value.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
async function readBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > limit) {
    void response.body?.cancel().catch(() => {});
    throw new QlooError("contract", "Qloo response exceeded the body limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit)
        throw new QlooError(
          "contract",
          "Qloo response exceeded the body limit.",
        );
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new QlooError("contract", "Qloo returned invalid UTF-8.");
    }
  } finally {
    // Do not await a faulty stream's cancellation indefinitely.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function statusError(
  status: number,
  retryAfterMs: number | undefined,
): QlooError {
  const kind =
    status === 401
      ? "auth"
      : status === 403
        ? "permission"
        : status === 404
          ? "not_found"
          : status === 429
            ? "rate_limit"
            : status >= 500
              ? "upstream"
              : "input";
  return new QlooError(kind, `Qloo returned HTTP ${status}.`, {
    status,
    retryable: (status === 429 && retryAfterMs !== undefined) || (status >= 500 && status <= 599),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
function ttlFor(endpoint: Endpoint): number {
  return endpoint === "/entities" || endpoint === "/v2/tags/types"
    ? 86_400_000
    : endpoint === "/search" || endpoint === "/v2/tags"
      ? 3_600_000
      : endpoint === "/v2/trending"
        ? 900_000
        : 300_000;
}
function isEmpty(data: unknown): boolean {
  const results = (data as { results?: unknown }).results;
  if (Array.isArray(results)) return results.length === 0;
  return (
    !!results &&
    typeof results === "object" &&
    Object.values(results).some((v) => Array.isArray(v) && v.length === 0)
  );
}

export class QlooClient {
  readonly #key: string | undefined;
  readonly #scope: string;
  private readonly transport: QlooTransport;
  private readonly cache: QlooCache;
  private readonly developmentCache: boolean;
  private readonly now: () => number;
  private readonly flights: Map<string, QlooFlight>;
  private readonly config: Required<
    Pick<
      QlooClientOptions,
      | "timeoutMs"
      | "totalDeadlineMs"
      | "maxAttempts"
      | "backoffMs"
      | "maxBackoffMs"
      | "maxResponseBytes"
      | "maxInflight"
    >
  >;
  // Keep only non-secret configuration. Do not retain the caller's options object.
  private readonly compatibility: boolean;
  private readonly isLocalError: QlooClientOptions["isLocalError"];
  private readonly observer: QlooClientOptions["onResponse"];
  private readonly random: () => number;
  private readonly sleeper: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(options: QlooClientOptions) {
    assertServer();
    this.flights = options.flightPool ?? new Map();
    if (options.origin !== QLOO_ORIGIN) throw inputError();
    this.transport = options.transport ?? {
      mode: "live",
      fetch: globalThis.fetch.bind(globalThis),
    };
    if (
      !["live", "fixture"].includes(this.transport.mode) ||
      typeof this.transport.fetch !== "function"
    )
      throw inputError();
    this.#key = this.transport.mode === "fixture" ? undefined : options.apiKey;
    if (
      this.transport.mode === "live" &&
      (!this.#key?.trim() || /[\r\n]/.test(this.#key))
    )
      throw new QlooError("auth", "A server-side Qloo API key is required.");
    this.#scope = createHash("sha256")
      .update(
        JSON.stringify([
          this.transport.mode,
          this.#key ?? "",
          options.cacheNamespace ?? "default",
        ]),
      )
      .digest("hex");
    this.developmentCache = !!options.devCache;
    this.cache = options.devCache ?? options.cache ?? new MemoryCache();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleeper = options.sleep ?? sleep;
    this.observer = options.onResponse;
    this.isLocalError = options.isLocalError;
    this.compatibility = options.allowCompatibilityTypes ?? false;
    this.config = {
      timeoutMs: options.timeoutMs ?? 8000,
      totalDeadlineMs: options.totalDeadlineMs ?? 12000,
      maxAttempts: options.maxAttempts ?? 2,
      backoffMs: options.backoffMs ?? 250,
      maxBackoffMs: options.maxBackoffMs ?? 1000,
      maxResponseBytes: options.maxResponseBytes ?? 5 * 1024 * 1024,
      maxInflight: options.maxInflight ?? 128,
    };
    for (const [key, value] of Object.entries(this.config)) {
      if (
        !Number.isSafeInteger(value) ||
        value < (key.includes("backoff") || key === "maxBackoffMs" ? 0 : 1)
      )
        throw inputError();
    }
    if (this.config.maxAttempts > 4) throw inputError();
  }

  searchEntities(query: SearchRequest, options?: RequestOptions) {
    return this.request("/search", query, "search", options);
  }
  getEntities(query: EntitiesRequest, options?: RequestOptions) {
    return this.request("/entities", query, "entities", options);
  }
  findTags(query: TagsRequest = {}, options?: RequestOptions) {
    return this.request("/v2/tags", query, "tags", options);
  }
  getTagTypes(query: TagTypesRequest = {}, options?: RequestOptions) {
    return this.request("/v2/tags/types", query, "tagTypes", options);
  }
  compare(query: CompareRequest, options?: RequestOptions) {
    return this.request("/v2/analysis/compare", query, "compare", options);
  }
  trending(query: TrendingRequest, options?: RequestOptions) {
    return this.request("/v2/trending", query, "trending", options);
  }
  insights<T extends InsightsType>(
    query: InsightsRequest<T>,
    options?: RequestOptions,
  ): Promise<QlooResult<InsightsResponse<T>>> {
    return this.request(
      "/v2/insights",
      query,
      insightsResponseName(query["filter.type"]),
      options,
    ) as Promise<QlooResult<InsightsResponse<T>>>;
  }

  private request<N extends ResponseName>(
    endpoint: Endpoint,
    input: unknown,
    responseName: N,
    options: RequestOptions = {},
  ): Promise<QlooResult<ResponseFor<N>>> {
    try {
      assertServer();
      if (options.signal?.aborted) throw cancelledError();
      const query = validateQuery(endpoint, input, this.compatibility);
      const requestedTtl = options.cacheTtlMs ?? ttlFor(endpoint);
      if (!Number.isSafeInteger(requestedTtl) || requestedTtl < 0) throw inputError();
      const ttl = this.developmentCache && requestedTtl > 0 ? 86_400_000 : requestedTtl;
      if (!Number.isSafeInteger(ttl) || ttl < 0) throw inputError();
      const key = createCacheKey(
        QLOO_ORIGIN,
        this.developmentCache ? `GET:private-development:${this.transport.mode}` : this.#scope,
        endpoint,
        query,
        responseName,
      );
      // Cache bypass has independent semantics from an otherwise identical cached request.
      const flightKey = `${key}:${ttl}`;
      let flight = this.flights.get(flightKey);
      if (!flight) {
        if (this.flights.size >= this.config.maxInflight)
          throw new QlooError(
            "rate_limit",
            "Too many concurrent Qloo requests.",
          );
        const controller = new AbortController();
        const promise = Promise.resolve().then(() =>
          this.execute(endpoint, query, responseName, key, ttl, controller),
        );
        flight = { controller, promise, subscribers: 0 };
        this.flights.set(flightKey, flight);
        const current = flight;
        void promise
          .finally(() => {
            if (this.flights.get(flightKey) === current)
              this.flights.delete(flightKey);
          })
          .catch(() => {});
      }
      return this.subscribe(flight, flightKey, options.signal) as Promise<
        QlooResult<ResponseFor<N>>
      >;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private subscribe(
    flight: QlooFlight,
    key: string,
    signal?: AbortSignal,
  ): Promise<QlooResult<unknown>> {
    flight.subscribers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", abort);
        flight.subscribers--;
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        if (flight.subscribers === 0) {
          flight.controller.abort(cancelledError());
          if (this.flights.get(key) === flight) this.flights.delete(key);
        }
        reject(cancelledError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      flight.promise.then(
        (value) => {
          if (finish()) resolve(structuredClone(value));
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  private async execute(
    endpoint: Endpoint,
    query: Query,
    responseName: ResponseName,
    cacheKey: string,
    ttl: number,
    controller: AbortController,
  ): Promise<QlooResult<unknown>> {
    const started = this.now();
    const deadline = started + this.config.totalDeadlineMs;
    const timer = setTimeout(
      () =>
        controller.abort(
          new QlooError("timeout", "Qloo request deadline exceeded."),
        ),
      this.config.totalDeadlineMs,
    );
    const signal = controller.signal;
    const schema = responseSchemas[responseName];
    try {
      if (signal.aborted) throw abortReason(signal);
      if (ttl > 0) {
        let entry: CacheEntry | undefined;
        try {
          entry = await abortable(this.cache.get(cacheKey), signal);
        } catch {
          if (signal.aborted) throw abortReason(signal);
        }
        if (entry) {
          const parsed = schema.safeParse(entry.value);
          const age = this.now() - Date.parse(entry.fetchedAt);
          if (parsed.success && Number.isFinite(age) && age >= 0 && age < ttl)
            return {
              data: parsed.data,
              provenance: {
                source: this.transport.mode === "fixture" ? "fixture" : "qloo",
                cache: "hit",
                fetchedAt: entry.fetchedAt,
                elapsedMs: this.now() - started,
                attempts: 0,
                endpoint,
              },
            };
          try {
            await abortable(this.cache.delete(cacheKey), signal);
          } catch {
            if (signal.aborted) throw abortReason(signal);
          }
        }
      }
      const url = `${QLOO_ORIGIN}${endpoint}?${encodeQuery(query)}`;
      let attempts = 0;
      while (true) {
        if (signal.aborted) throw abortReason(signal);
        if (this.now() >= deadline)
          throw new QlooError("timeout", "Qloo request deadline exceeded.");
        attempts++;
        try {
          const body = await this.attempt(url, endpoint, responseName, signal);
          if (
            body &&
            typeof body === "object" &&
            "success" in body &&
            body.success === false
          )
            throw new QlooError(
              "upstream",
              "Qloo reported an unsuccessful request.",
              { status: 200 },
            );
          const parsed = schema.safeParse(body);
          if (!parsed.success)
            throw new QlooError(
              "contract",
              "Qloo response did not match its schema.",
              {
                issues: parsed.error.issues.map((issue) => ({
                  path: issue.path
                    .map((segment) =>
                      this.#key
                        ? String(segment).split(this.#key).join("[REDACTED]")
                        : String(segment),
                    )
                    .join("."),
                  code: issue.code,
                })),
              },
            );
          const fetchedAt = new Date(this.now()).toISOString();
          if (ttl > 0) {
            try {
              await abortable(
                this.cache.set(
                  cacheKey,
                  { value: parsed.data, fetchedAt },
                  isEmpty(parsed.data) ? Math.min(ttl, 30_000) : ttl,
                ),
                signal,
              );
            } catch {
              if (signal.aborted) throw abortReason(signal);
            }
          }
          return {
            data: parsed.data,
            provenance: {
              source: this.transport.mode === "fixture" ? "fixture" : "qloo",
              cache: "miss",
              fetchedAt,
              elapsedMs: this.now() - started,
              attempts,
              endpoint,
            },
          };
        } catch (cause) {
          if (this.isLocalError?.(cause)) throw cause;
          if (signal.aborted) throw abortReason(signal);
          const error =
            cause instanceof QlooError
              ? cause
              : new QlooError("network", "Qloo transport failed.", { retryable: true });
          // One retry for transient transport failures, still within operation/run bounds.
          if (!error.retryable || attempts >= this.config.maxAttempts || (error.kind === "network" && attempts >= 2))
            throw error;
          const jitter =
            Math.max(0, Math.min(1, this.random())) *
            Math.min(
              this.config.maxBackoffMs,
              this.config.backoffMs * 2 ** (attempts - 1),
            );
          const delay = Math.max(jitter, error.retryAfterMs ?? 0);
          if (!Number.isFinite(delay) || delay >= deadline - this.now())
            throw error;
          await abortable(this.sleeper(delay, signal), signal);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async attempt(
    url: string,
    endpoint: Endpoint,
    responseName: ResponseName,
    parent: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const relay = () => controller.abort(abortReason(parent));
    parent.addEventListener("abort", relay, { once: true });
    if (parent.aborted) relay();
    const signal = controller.signal;
    const timer = setTimeout(
      () =>
        controller.abort(new QlooError("timeout", "Qloo attempt timed out.")),
      this.config.timeoutMs,
    );
    try {
      const response = await abortable(
        this.transport.fetch(url, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            Accept: "application/json",
            ...(this.#key ? { "X-Api-Key": this.#key } : {}),
          },
        }),
        signal,
      );
      const retryAfter = parseRetryAfter(
        response.headers.get("retry-after"),
        this.now(),
      );
      // Preserve status-based retries even for HTML error pages. Read errors only for diagnostics.
      if (!response.ok && !this.observer) {
        void response.body?.cancel().catch(() => {});
        throw statusError(response.status, retryAfter);
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      const isJson =
        contentType === "application/json" || !!contentType?.endsWith("+json");
      const text = await readBody(
        response,
        this.config.maxResponseBytes,
        signal,
      );
      let body: unknown = text;
      let validJson = false;
      if (isJson) {
        try {
          body = JSON.parse(text);
          validJson = true;
        } catch {
          /* Retain bounded text for private diagnostics. */
        }
      }
      if (this.observer) {
        try {
          await abortable(
            Promise.resolve(
              this.observer({
                endpoint,
                responseName,
                status: response.status,
                body: structuredClone(body),
              }),
            ),
            signal,
          );
        } catch {
          if (signal.aborted) throw abortReason(signal);
          throw new QlooError("upstream", "Qloo response observer failed.");
        }
      }
      if (!response.ok) throw statusError(response.status, retryAfter);
      if (!isJson)
        throw new QlooError("contract", "Qloo returned a non-JSON response.");
      if (!validJson)
        throw new QlooError("contract", "Qloo returned invalid JSON.");
      return body;
    } catch (error) {
      if (this.isLocalError?.(error)) throw error;
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof QlooError) throw error;
      if (error instanceof z.ZodError)
        throw new QlooError("contract", "Qloo response validation failed.");
      throw new QlooError("network", "Qloo transport failed.", { retryable: true });
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", relay);
    }
  }
}
