import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { MemoryStore, DAY, MONTH } from "@/lib/server/store";
import { createDraft, owned, listDrafts, saveDraft, createShare, ownedLinks, manageShare, publicShare, openReceipt, receiptAction } from "@/lib/server/repository";
import { startRun, executeRun, ownedRun, publicRun } from "@/lib/server/runs";
import { qlooFailure } from "@/lib/server/qloo";
import { current, type Draft, type Kind } from "@/lib/domain";
import { SelectionTools } from "@/lib/agent/tools";
import * as agent from "@/lib/agent";
import { QlooError } from "@/lib/qloo/errors";
let memory: MemoryStore;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); vi.restoreAllMocks();
  for (const key of ["QLOO_API_KEY", "ANTHROPIC_API_KEY",  "TIFFIN_PROJECT", "REQUIRE_REDIS", "PUBLIC_DEMO", "QLOO_DEV_CACHE_DIR"]) vi.stubEnv(key, "");
  memory = new MemoryStore();
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = memory;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); vi.restoreAllMocks(); });
async function generate(d: Draft, slotId?: Kind) {
  const r = await startRun({ action: slotId ? "repair" : "prepare", draftId: d.id, slotId, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, d.owner, "ip");
  await executeRun(r.run, r.draft!, () => {});
  return owned(d.id, d.owner);
}
async function prepared() { return generate(await createDraft("owner", "sample", "quiet-evenings")); }
const publish = (d: Draft) => createShare(d.id, d.owner, { expectedVersion: d.version, idempotencyKey: crypto.randomUUID(), repairEnabled: true, approvedIds: d.shelf.map((e) => e.entity.id) });
it("unpublished selections do not become publication history", async () => {
  const d = await prepared(); const next = await createDraft(d.owner, "repeat", undefined, d.id);
  expect(next.shared).toEqual([]);
});
it("share, repair, re-share keeps original link immutable", async () => {
  const d = await prepared(), first = await publish(d);
  const repaired = await generate(await owned(d.id, d.owner), "book");
  const second = await publish(repaired);
  expect(second.share.revision.slots.filter((s) => s.kind !== "book")).toEqual(first.share.revision.slots.filter((s) => s.kind !== "book"));
  expect(second.share.revision.slots[1].entity.id).not.toBe(first.share.revision.slots[1].entity.id);
  expect((await publicShare(first.token)).revision).toEqual(first.share.revision);
});
it("post-share refinement preserves a kept piece from this gift", async () => {
  const d = await prepared(); await publish(d);
  const latest = await owned(d.id, d.owner);
  const locked = await saveDraft(d.id, d.owner, { expectedVersion: latest.version, lock: { kind: "movie", locked: true } });
  const refined = await generate(locked);
  expect(current(refined)?.slots.find((s) => s.kind === "movie")).toEqual(current(locked)?.slots.find((s) => s.kind === "movie"));
  expect(current(refined)?.id).not.toBe(current(locked)?.id);
  const next = await createDraft(d.owner, "repeat", undefined, d.id);
  expect(next.shared).toContain(current(d)!.slots[0].entity.id);
});
it("repair pools use history published after the draft was read", async () => {
  const d = await prepared(), selected = current(d)!.slots.map((s) => s.entity.id);
  const newlyShared = d.shelf.find((e) => !selected.includes(e.entity.id))!.entity.id;
  const key = `profile:${d.owner}:${d.profileId ?? d.id}`, get = memory.get.bind(memory);
  let reads = 0;
  vi.spyOn(memory, "get").mockImplementation(async (candidate) => {
    if (candidate === key && ++reads === 2) await memory.cas(key, null, JSON.stringify({ shared: [newlyShared] }), MONTH);
    return get(candidate);
  });
  const result = await publish(d);
  expect(result.share.pool.map((e) => e.entity.id)).not.toContain(newlyShared);
  expect((await owned(d.id, d.owner)).shared).toContain(newlyShared);
});
it("sibling repeat drafts observe atomic publication history at preflight and publish", async () => {
  const a = await prepared(); await publish(a);
  const b = await createDraft(a.owner, "repeat", undefined, a.id);
  const c = await createDraft(a.owner, "repeat", undefined, a.id);
  const readyB = await generate(b);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 61000);
  const readyC = await generate(c);
  expect(current(readyC)?.slots.map((s) => s.entity.id)).toEqual(current(readyB)?.slots.map((s) => s.entity.id));
  await publish(readyB);
  await expect(publish(readyC)).rejects.toThrow("Update their mixtape");
  expect((await owned(c.id, c.owner)).shared).toHaveLength(6);
  await expect(generate(await owned(c.id, c.owner))).rejects.toThrow("Add one more");
});
it("rotated link is recoverable without invalidating it again", async () => {
  const d = await prepared(), s = await publish(d), rotated = await manageShare(s.share.id, d.owner, true);
  expect((await ownedLinks(d.id, d.owner))[0].path).toBe(`/m/${rotated.token}`);
  await expect(publicShare(s.token)).rejects.toThrow("no longer available");
  expect((await publicShare(rotated.token!)).id).toBe(s.share.id);
});
it("discovery-index storage failure is unavailable, never an empty successful list", async () => {
  const d = await createDraft("owner", "empty"), original = memory.get.bind(memory);
  vi.spyOn(memory, "get").mockImplementation((key) => key === `index:${d.owner}` ? Promise.reject(new Error("storage unavailable")) : original(key));
  await expect(listDrafts(d.owner)).rejects.toThrow("cannot start");
});
it("Gateway insufficient credits uses terminal pause copy", () => {
  expect(qlooFailure(Object.assign(new Error("credits"), { statusCode: 402 })).message).toBe("New mixtapes are paused for now. Saved links still work.");
});
it("editing renews draft and discovery together", async () => {
  const t = Date.now(), d = await createDraft("owner", "empty");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t + 29 * DAY);
  await saveDraft(d.id, d.owner, { expectedVersion: d.version, introduction: "Still editing" });
  vi.setSystemTime(t + 31 * DAY);
  expect((await owned(d.id, d.owner)).introduction).toBe("Still editing");
  expect(await listDrafts(d.owner)).toHaveLength(1);
});
it("publishing on day 29 keeps link management until the link expires", async () => {
  const d = await prepared(), t = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(t + 29 * DAY);
  await publish(d); vi.setSystemTime(t + 31 * DAY);
  expect(await ownedLinks(d.id, d.owner)).toHaveLength(1);
  expect(await listDrafts(d.owner)).toHaveLength(1);
});
it("recipient exhaustion has actionable copy and consumes no inference turn", async () => {
  const d = await prepared();
  const s = await createShare(d.id, d.owner, { expectedVersion: d.version, idempotencyKey: crypto.randomUUID(), repairEnabled: true, approvedIds: d.shelf.filter((e) => e.entity.kind === "movie").map((e) => e.entity.id) });
  let g = await openReceipt(s.token, "reader");
  g = await receiptAction(g.receiptId!, "reader", { action: "known", slotId: "book", expectedVersion: g.version! });
  const original = memory.cas.bind(memory); const spy = vi.spyOn(memory, "cas").mockImplementation(original);
  await expect(startRun({ action: "repair", receiptRef: g.receiptId, slotId: "book", expectedVersion: g.version!, idempotencyKey: crypto.randomUUID() }, "reader", "reader-ip")).rejects.toThrow("There is no other book in this mixtape.");
  expect(spy.mock.calls.some(([key]) => key.startsWith("limit:inference"))).toBe(false);
  const after = await openReceipt(s.token, "reader");
  expect(after.slots).toEqual(g.slots); expect(after.known).toEqual(g.known);
});
it("run projection preserves a known upstream cooldown after streaming starts", async () => {
  const d = await prepared();
  vi.spyOn(agent, "runSelection").mockRejectedValue(new QlooError("rate_limit", "private", { retryAfterMs: 60000 }));
  const r = await startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, d.owner, "ip");
  await executeRun(r.run, r.draft!, () => {});
  const result = publicRun(await ownedRun(r.run.id, d.owner));
  expect(result.status).toBe("failed"); expect(result.failure?.status).toBe(429);
  expect(result.failure?.resetAt).toBeGreaterThan(Date.now() + 59000);
  expect(current(await owned(d.id, d.owner))).toEqual(current(d));
});
it("clarifications require an observed matching failure", async () => {
  const d = await createDraft("owner", "fixture", "quiet-evenings");
  const t = new SelectionTools(d, null, new AbortController().signal, async () => {}, async () => {});
  await expect(t.requestInput("book", "shelf_exhausted")).rejects.toThrow("agent could not finish");
  await expect(t.requestInput("book", "no_supported_result")).rejects.toThrow("agent could not finish");
  t.outcomes.set("book", { status: "empty", eligible: 3, returned: 0, missing: 3, rejected: 0, retryAllowed: false });
  expect(await t.requestInput("book", "no_supported_result")).toMatchObject({ status: "needs_input" });
});
it("explicit deterministic fallback does not invoke a model with credentials", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic");
  expect(agent.executionMode()).toBe("deterministic");
  const d = await prepared(); expect(current(d)?.slots).toHaveLength(3);
});
it("reviewed sample cache is reused across owners without development caching; edits stay private", async () => {
  const { liveSampleSchema, selectionCacheScope } = await import("@/lib/server/sample-manifest");
  const { put, MONTH } = await import("@/lib/server/store");
  const { client } = await import("@/lib/server/qloo");
  const base = await createDraft("editor", "fixture", "quiet-evenings");
  for (const e of [...base.shelf.map((entry) => entry.entity), ...base.tastes]) { e.id = crypto.randomUUID().toUpperCase(); e.mode = "live"; }
  await put("live-sample:quiet-evenings", liveSampleSchema, { sampleId: "quiet-evenings", shelf: base.shelf, tastes: base.tastes, validatedAt: new Date().toISOString(), coverageConfirmed: true, repairConfirmed: true, signalResponsivenessConfirmed: true }, MONTH);
  vi.stubEnv("QLOO_API_KEY", "synthetic"); vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01");
  const a = await createDraft("A", "sample", "quiet-evenings"), b = await createDraft("B", "sample", "quiet-evenings");
  const aScope = await selectionCacheScope(a), bScope = await selectionCacheScope(b);
  expect(aScope).toBe(bScope); expect(aScope).toMatch(/^editorial:/);
  const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, results: { entities: [{ entity_id: a.shelf[0].entity.id, name: "Synthetic title", subtype: "urn:entity:movie", query: { affinity: 0.8 } }] } }));
  const query = { "filter.type": "urn:entity:movie" as const, "signal.interests.entities": a.tastes.map((e) => e.id), "filter.results.entities": a.shelf.filter((e) => e.entity.kind === "movie").map((e) => e.entity.id) };
  const first = await client(aScope).insights(query);
  const second = await client(bScope).insights(query);
  expect(second.provenance).toMatchObject({ cache: "hit", fetchedAt: first.provenance.fetchedAt }); expect(network).toHaveBeenCalledTimes(1);
  b.tastes[0].id = crypto.randomUUID().toUpperCase(); expect(await selectionCacheScope(b)).toMatch(/^B:/);
  a.excluded.push(a.shelf[0].entity.id); expect(await selectionCacheScope(a)).toMatch(/^A:/);
});
it("public Qloo access defaults to a bounded demo allocation and rejects invalid overrides", async () => {
  const { ensureQlooAccess, qlooAttempt } = await import("@/lib/server/limits");
  vi.stubEnv("PUBLIC_DEMO", "true"); vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01");
  expect(() => ensureQlooAccess()).not.toThrow();
  vi.stubEnv("QLOO_ALLOCATION_CONFIRMED", "true"); vi.stubEnv("QLOO_DAILY_ATTEMPTS", "2"); vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "2");
  const attempts = await Promise.allSettled([qlooAttempt(memory), qlooAttempt(memory), qlooAttempt(memory)]);
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "10000"); expect(() => ensureQlooAccess()).toThrow();
});
it("new comparison policy retains previous records and cannot reuse their completion", async () => {
  const { freezeEvaluationInput, evaluateCase, getComparison } = await import("@/lib/server/comparison");
  const d = await createDraft("owner", "fixture", "quiet-evenings"); d.mode = "live";
  d.known = d.shelf.filter((e) => e.entity.kind === "book").map((e) => e.entity.id);
  await freezeEvaluationInput("quiet-evenings", d);
  const first = await evaluateCase("quiet-evenings", d, d.owner, "ip");
  for (const [key, value] of Object.entries({ MIXTAPE_AGENT_MODE: "anthropic", ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_MODEL: "test/model", MODEL_POLICY_MODEL: "test/model", MODEL_COST_BOUND_CONFIRMED: "true", MODEL_BYTE_TOKEN_BOUND_CONFIRMED: "true", MODEL_INPUT_USD_PER_MILLION: ".1", MODEL_OUTPUT_USD_PER_MILLION: ".5" })) vi.stubEnv(key, value);
  const next = await evaluateCase("quiet-evenings", d, d.owner, "ip");
  expect(next.version).not.toBe(first.version); expect(next.method).toBe("policy-comparison");
  expect(await memory.get(`comparison:quiet-evenings:${first.version}`)).not.toBeNull();
  expect((await getComparison("quiet-evenings"))?.version).toBe(next.version);
});
