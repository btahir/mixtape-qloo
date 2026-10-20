import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entitySchema } from "@/lib/qloo/schemas";
import { contributions, demoContentAllowed, entityKind, invalidRequiredSignal } from "@/lib/qloo/normalize";
import { projectEntity, client } from "@/lib/server/qloo";
import { DiskCache, recordDevelopmentAttempt } from "@/lib/qloo/disk-cache";
import { QlooClient, QLOO_ORIGIN } from "@/lib/qloo/client";
import { paceQloo } from "@/lib/server/qloo-pacing";
import { MemoryStore } from "@/lib/server/store";
import { createDraft } from "@/lib/server/repository";
import { SelectionTools, filterRanking } from "@/lib/agent/tools";
import { runSelection } from "@/lib/agent";
import { evaluateCase, freezeEvaluationInput } from "@/lib/server/comparison";
import type { Draft } from "@/lib/domain";
const a = "12345678-1234-4123-8123-123456789abc", b = "abcdefab-1234-4123-8123-123456789abc";
let directory: string | undefined;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); vi.restoreAllMocks();
  for (const key of ["QLOO_API_KEY", "ANTHROPIC_API_KEY", "TIFFIN_PROJECT", "PUBLIC_DEMO", "APP_ORIGIN", "QLOO_DEV_CACHE_DIR"]) vi.stubEnv(key, "");
  vi.stubEnv("QLOO_SAMPLE_DIR", ".qa/unit-empty-samples");
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = new MemoryStore();
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); vi.restoreAllMocks(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
async function temp() { await mkdir(".qa", { recursive: true }); return directory = await mkdtemp(".qa/unit-r4-"); }
async function liveDraft() {
  const d = structuredClone(await createDraft("editor", "fixture", "quiet-evenings")); d.mode = "live";
  for (const e of [...d.shelf.map((s) => s.entity), ...d.tastes]) { e.mode = "live"; e.id = crypto.randomUUID(); }
  return d;
}
const response = (d: Draft) => vi.fn(async (p: { "filter.type": string; "filter.results.entities"?: string[] }) => ({ data: { results: { entities: (p["filter.results.entities"] ?? []).map((id) => ({ entity_id: id.toUpperCase(), name: "Resolved favourite", type: "urn:entity", subtype: p["filter.type"], query: { affinity: 0, explainability: { "signal.interests.entities": [{ entity_id: d.tastes[0].id.toUpperCase(), score: 0 }] } } })) } }, provenance: { fetchedAt: "2026-10-19T00:00:00Z", cache: "miss" } }));

it("decodes live types and strict incomplete tags without accepting conflicting categories", () => {
  const raw = entitySchema.parse({ entity_id: a, name: "Title", types: ["urn:entity:book"], tags: [{ type: "urn:tag:voice_type:qloo" }] });
  expect(entityKind(raw)).toBe("book");
  expect(entityKind({ ...raw, subtype: "urn:entity:movie" })).toBeNull();
  expect(entitySchema.safeParse({ ...raw, tags: [{ type: "urn:tag:voice_type:qloo", id: "invalid" }] }).success).toBe(false);
  expect(filterRanking([{ ...raw, entity_id: a.toUpperCase() }], [a], "book", []).valid).toHaveLength(1);
  expect(filterRanking([raw], [a], "book", [a.toUpperCase()]).valid).toHaveLength(0);
});
it("preserves disambiguation, localized prose, safe images and provider destinations", () => {
  const raw = entitySchema.parse({ entity_id: a, name: "Book", types: ["urn:entity:book"], disambiguation: "1972, An Author", properties: { publication_year: 1972, image: { url: "https://images.qloo.com/book.jpg", attribution: "Publisher" }, external: { goodreads: { id: "123" } } }, short_descriptions: [{ languages: ["en"], value: "English prose" }] });
  expect(projectEntity(raw, "live", "now")).toMatchObject({ id: a.toUpperCase(), detail: "1972, An Author", imageAttribution: "Publisher", description: "English prose", destination: "https://www.goodreads.com/book/show/123" });
  expect(projectEntity({ ...raw, properties: { image: { url: "javascript:alert(1)" } } }, "live", "now")?.imageUrl).toBeUndefined();
});
it("uses only valid individual contributions and preserves zero", () => {
  const raw = { entity_id: a, name: "Title", query: { explainability: { "signal.interests.entities": [{ entity_id: b.toUpperCase(), score: 0 }] } } };
  expect(contributions(raw, [b])).toEqual([{ entityId: b.toUpperCase(), score: 0 }]);
  expect(contributions(raw, [a])).toBeUndefined();
  raw.query.explainability["signal.interests.entities"].push({ entity_id: b, score: 0.5 });
  expect(contributions(raw, [b])).toBeUndefined();
  expect(invalidRequiredSignal([{ type: "not_found", "signal.interests.entities": [b.toUpperCase()] }], [b])).toBe(true);
});
it("runs the disclosed local policy against real-shaped Qloo tools without Gateway", async () => {
  const d = await liveDraft(), insights = response(d);
  const t = new SelectionTools(d, { insights, getEntities: vi.fn() } as never, new AbortController().signal, async () => {}, async () => {});
  const result = await runSelection(t);
  expect(result.status).toBe("ready"); expect(insights).toHaveBeenCalledTimes(3);
  expect(result.slots.every((s) => s.method === "qloo" && s.evidence.score === 0 && s.evidence.explanationStatus === "verified")).toBe(true);
});
it("refuses a successful shortlist response when a required taste was not found", async () => {
  const d = await liveDraft(), ordinary = response(d);
  const insights = vi.fn(async (p) => { const r = await ordinary(p); return { ...r, data: { ...r.data, warnings: [{ type: "not_found", "signal.interests.entities": [d.tastes[0].id.toUpperCase()] }] } }; });
  const t = new SelectionTools(d, { insights, getEntities: vi.fn() } as never, new AbortController().signal, async () => {}, async () => {});
  await expect(runSelection(t)).rejects.toThrow(`Qloo cannot use ${d.tastes[0].name} as a taste. Choose another identity or a different taste.`);
  expect(t.committed).toBe(false); expect(t.results.size).toBe(0);
});
it("reuses private disk responses across owners and credentials with original timestamps and no attempt", async () => {
  const dir = await temp(), transport = { mode: "live" as const, fetch: vi.fn(async () => Response.json({ results: [{ entity_id: a, name: "Title", types: ["urn:entity:book"] }] })) };
  const first = new QlooClient({ origin: QLOO_ORIGIN, apiKey: "synthetic-a", cacheNamespace: "owner-a", devCache: new DiskCache(dir), transport });
  const r = await first.searchEntities({ query: "Title", take: 5 });
  const second = new QlooClient({ origin: QLOO_ORIGIN, apiKey: "synthetic-b", cacheNamespace: "owner-b", devCache: new DiskCache(dir), transport });
  const cached = await second.searchEntities({ take: 5, query: "Title" });
  expect(cached.provenance).toMatchObject({ cache: "hit", attempts: 0, fetchedAt: r.provenance.fetchedAt });
  await second.searchEntities({ take: 5, query: "Changed" });
  expect(transport.fetch).toHaveBeenCalledTimes(2);
  await expect(second.searchEntities({ query: "Title" }, { cacheTtlMs: Infinity })).rejects.toThrow();
  const fixture = new QlooClient({ origin: QLOO_ORIGIN, devCache: new DiskCache(dir), transport: { ...transport, mode: "fixture" } });
  await fixture.searchEntities({ query: "Title", take: 5 });
  expect(transport.fetch).toHaveBeenCalledTimes(3);
  for (const file of await readdir(dir)) expect(await readFile(join(dir, file), "utf8")).not.toMatch(/synthetic-a|synthetic-b|owner-a|owner-b/);
});
it("backs off one second on Qloo's known short throttle even without Retry-After", async () => {
  vi.stubEnv("QLOO_API_KEY", "synthetic"); vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01");
  const times: number[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    times.push(Date.now());
    return times.length === 1 ? new Response(null, { status: 429, headers: { "x-month-ratelimit-remaining": "1000" } }) : Response.json({ results: [] });
  });
  const result = await client("throttle-test").searchEntities({ query: "Unique throttle query" }, { cacheTtlMs: 0 });
  expect(result.provenance.attempts).toBe(2); expect(fetcher).toHaveBeenCalledTimes(2); expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
});
it("limits concurrent admissions to the remaining development budget", async () => {
  const dir = await temp(); await writeFile(join(dir, "attempts.ndjson"), "{}\n".repeat(149));
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => recordDevelopmentAttempt(dir, `${QLOO_ORIGIN}/search?query=private`)));
  expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
  const ledger = await readFile(join(dir, "attempts.ndjson"), "utf8"); expect(ledger.trim().split("\n")).toHaveLength(150); expect(ledger).not.toContain("private");
});
it("paces simultaneous callers across the shared store and aborts pending work", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const s = new MemoryStore(), times: number[] = [];
  const jobs = Promise.all(Array.from({ length: 5 }, () => paceQloo(new AbortController().signal, s).then(() => times.push(Date.now()))));
  await vi.advanceTimersByTimeAsync(1500); await jobs;
  times.sort((a, b) => a - b); for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(260);
  await expect(paceQloo(AbortSignal.abort(), s)).rejects.toThrow();
});
it("keeps editorial content controls separate from explicit choice projection", () => {
  const raw = { entity_id: a, name: "Lolita", types: ["urn:entity:book"] };
  expect(demoContentAllowed(raw)).toBe(false); expect(projectEntity(raw, "live", "now")?.name).toBe("Lolita");
  expect(demoContentAllowed({ ...raw, name: "A book", tags: [{ id: "urn:tag:theme:qloo:lgbtq", name: "LGBTQ themes" }] })).toBe(true);
});
it("labels and retains a real-shaped deterministic comparison without pretending a model ran", async () => {
  const d = await liveDraft();
  vi.stubEnv("QLOO_API_KEY", "synthetic"); vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01");
  vi.spyOn(QlooClient.prototype, "insights").mockImplementation(response(d) as never);
  await freezeEvaluationInput("quiet-evenings", d);
  const result = await evaluateCase("quiet-evenings", d, "editor", "test-ip");
  expect(result.method).toBe("deterministic-ablation"); expect(result.model).toBe("deterministic-local-stub");
  expect(result.withQloo.failure).toBeNull(); expect(result.withoutQloo.failure).toBeNull(); expect(result.withQloo.reservedUsd).toBe(0);
  expect(result.withoutQloo.choices.map((c) => c.entityId)).toEqual(d.categories.map((kind) => d.shelf.find((s) => s.entity.kind === kind)!.entity.id));
});
