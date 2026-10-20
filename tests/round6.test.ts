import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { current, type Draft } from "@/lib/domain";
import { MemoryStore } from "@/lib/server/store";
import { createDraft, owned, createShare, manageShare, openReceipt, ownedReceipt, receiptAction, receiptIndexKey, saveDraft, existingGift } from "@/lib/server/repository";
import { startRun, executeRun, ownedRun, cancelRun } from "@/lib/server/runs";
import { SelectionTools } from "@/lib/agent/tools";
import { AppError } from "@/lib/server/errors";
import { client } from "@/lib/server/qloo";
let memory: MemoryStore;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); vi.restoreAllMocks();
  for (const key of ["QLOO_API_KEY", "ANTHROPIC_API_KEY",  "TIFFIN_PROJECT", "REQUIRE_REDIS", "PUBLIC_DEMO", "QLOO_DEV_CACHE_DIR", "QLOO_ORIGIN", "REDIS_URL", "VALKEY_PREFIX"]) vi.stubEnv(key, "");
  vi.stubEnv("QLOO_MODE", "fixture");
  memory = new MemoryStore();
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = memory;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); });
async function prepare(d: Draft) {
  const started = await startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, d.owner, "ip");
  await executeRun(started.run, started.draft!, () => {});
  expect((await ownedRun(started.run.id, d.owner)).status).toBe("ready");
  return owned(d.id, d.owner);
}
async function shared() {
  const d = await prepare(await createDraft("owner", "fixture", "quiet-evenings"));
  const s = await createShare(d.id, d.owner, { expectedVersion: d.version, repairEnabled: true, approvedIds: d.shelf.map((e) => e.entity.id), idempotencyKey: crypto.randomUUID() });
  return { ...s, gift: await openReceipt(s.token, "reader") };
}
function emptyRank() {
  return vi.spyOn(SelectionTools.prototype, "rank").mockImplementation(async function (this: SelectionTools, kind) {
    const outcome = { status: "empty" as const, eligible: 2, returned: 0, missing: 2, rejected: 0, retryAllowed: false };
    this.outcomes.set(kind, outcome);
    return outcome;
  });
}
it("rotation denies old receipt reads, reactions and repair runs and gives the replacement a new receipt", async () => {
  const { share, token, gift } = await shared();
  expect(receiptIndexKey("reader", share)).toBe(`receipt-index:reader:${share.id}`);
  const rotated = await manageShare(share.id, "owner", true);
  await expect(openReceipt(token, "reader")).rejects.toMatchObject({ status: 404 });
  await expect(ownedReceipt(gift.receiptId!, "reader")).rejects.toMatchObject({ status: 404 });
  await expect(receiptAction(gift.receiptId!, "reader", { action: "save", slotId: "book", expectedVersion: gift.version! })).rejects.toMatchObject({ status: 404 });
  await expect(startRun({ action: "repair", receiptRef: gift.receiptId!, slotId: "book", expectedVersion: gift.version!, idempotencyKey: crypto.randomUUID() }, "reader", "ip")).rejects.toMatchObject({ status: 404 });
  const fresh = await openReceipt(rotated.token!, "reader");
  expect(fresh.receiptId).not.toBe(gift.receiptId); expect(fresh.generation).toBe(1);
  expect(fresh.slots).toEqual(gift.slots);
});
it("rotation racing a receipt action wins the atomic share guard", async () => {
  const { share, gift } = await shared(), batch = memory.batchCas.bind(memory);
  let raced = false;
  vi.spyOn(memory, "batchCas").mockImplementation(async (writes, deadline) => {
    if (!raced && writes.some((w) => w.key === `receipt:${gift.receiptId}`)) { raced = true; await manageShare(share.id, "owner", true); }
    return batch(writes, deadline);
  });
  await expect(receiptAction(gift.receiptId!, "reader", { action: "save", slotId: "book", expectedVersion: gift.version! })).rejects.toMatchObject({ status: 409 });
  expect(JSON.parse((await memory.get(`receipt:${gift.receiptId}`))!).saved).toEqual([]);
});
it("rotation racing a completed repair cannot commit its new piece", async () => {
  const { share, gift } = await shared(), batch = memory.batchCas.bind(memory);
  const run = await startRun({ action: "repair", receiptRef: gift.receiptId!, slotId: "book", expectedVersion: gift.version!, idempotencyKey: crypto.randomUUID() }, "reader", "ip");
  let raced = false;
  vi.spyOn(memory, "batchCas").mockImplementation(async (writes, deadline) => {
    if (!raced && writes.some((w) => w.key === `receipt:${gift.receiptId}`)) { raced = true; await manageShare(share.id, "owner", true); }
    return batch(writes, deadline);
  });
  await executeRun(run.run, run.draft!, () => {});
  expect(raced).toBe(true);
  expect(current(JSON.parse((await memory.get(`receipt:${gift.receiptId}`))!))!.slots).toEqual(gift.slots);
});
it("valid empty repair stays blocked across save, undo, re-mark and new idempotency keys", async () => {
  const { token, gift } = await shared();
  let next = await receiptAction(gift.receiptId!, "reader", { action: "known", slotId: "book", expectedVersion: gift.version! });
  const rank = emptyRank();
  const input = () => ({ action: "repair" as const, receiptRef: next.receiptId!, slotId: "book" as const, expectedVersion: next.version!, idempotencyKey: crypto.randomUUID() });
  const run = await startRun(input(), "reader", "ip"); await executeRun(run.run, run.draft!, () => {});
  expect((await ownedRun(run.run.id, "reader")).status).toBe("needs_input");
  next = await openReceipt(token, "reader");
  expect(next.blockedRepairs).toEqual(["book"]); expect(next.slots).toEqual(gift.slots);
  next = await receiptAction(next.receiptId!, "reader", { action: "save", slotId: "movie", expectedVersion: next.version! });
  await expect(startRun(input(), "reader", "ip")).rejects.toThrow("Qloo did not return a choice");
  next = await receiptAction(next.receiptId!, "reader", { action: "undo", slotId: "book", expectedVersion: next.version! });
  next = await receiptAction(next.receiptId!, "reader", { action: "known", slotId: "book", expectedVersion: next.version! });
  await expect(startRun(input(), "reader", "ip")).rejects.toThrow("Qloo did not return a choice");
  expect(rank).toHaveBeenCalledTimes(1);
});
it("cancellation racing an empty outcome commits neither its marker nor receipt version", async () => {
  const { gift } = await shared(), batch = memory.batchCas.bind(memory); emptyRank();
  const run = await startRun({ action: "repair", receiptRef: gift.receiptId!, slotId: "book", expectedVersion: gift.version!, idempotencyKey: crypto.randomUUID() }, "reader", "ip");
  let raced = false;
  vi.spyOn(memory, "batchCas").mockImplementation(async (writes, deadline) => {
    if (!raced && writes.some((w) => w.key === `receipt:${gift.receiptId}`)) { raced = true; await cancelRun(run.run.id, "reader"); }
    return batch(writes, deadline);
  });
  await executeRun(run.run, run.draft!, () => {});
  const { r } = await ownedReceipt(gift.receiptId!, "reader");
  expect(r.version).toBe(gift.version); expect(r.blockedRepairs).toEqual([]);
  expect((await ownedRun(run.run.id, "reader")).status).toBe("cancelled");
});
it("explicit live setup never silently creates fixture drafts", async () => {
  vi.stubEnv("QLOO_MODE", "live");
  await expect(createDraft("a", "empty")).rejects.toThrow("We cannot reach Qloo with this setup.");
  await expect(createDraft("a", "sample", "quiet-evenings")).rejects.toThrow("We cannot reach Qloo with this setup.");
  expect((await createDraft("a", "fixture", "quiet-evenings")).mode).toBe("fixture");
});
it("return favourites confirm a validated subset and reject foreign IDs", async () => {
  const { token } = await shared();
  let d = await createDraft("reader", "return", undefined, token);
  const chosen = d.returnCandidates![1];
  await expect(saveDraft(d.id, "reader", { expectedVersion: d.version, confirmReturnFavourites: ["foreign"] })).rejects.toMatchObject({ status: 400 });
  d = await saveDraft(d.id, "reader", { expectedVersion: d.version, confirmReturnFavourites: [chosen.id] });
  expect(d.shelf.map((e) => e.entity.id)).toEqual([chosen.id]); expect(d.shelf[0].note).toBe(""); expect(d.returnCandidates).toBeUndefined();
});
it("draft creation cannot orphan a draft when the discovery transaction fails", async () => {
  const batch = memory.batchCas.bind(memory);
  vi.spyOn(memory, "batchCas").mockImplementation(async (writes, deadline) => {
    if (writes.some((w) => w.key.startsWith("index:"))) throw new Error("Storage unavailable");
    return batch(writes, deadline);
  });
  await expect(createDraft("new", "fixture", "quiet-evenings")).rejects.toThrow("Storage unavailable");
});
function enableQloo() {
  vi.stubEnv("QLOO_MODE", "live"); vi.stubEnv("QLOO_API_KEY", "synthetic-not-a-key");
  vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
}
it("local attempt denial retains status and cooldown without transport or retry", async () => {
  enableQloo(); const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  const denial = new AppError(429, "Local attempt allocation exhausted.", 7), attempt = vi.fn(async () => { throw denial; });
  await expect(client(`editorial:${crypto.randomUUID()}`, attempt).searchEntities({ query: "synthetic", types: ["urn:entity:movie"] }, { cacheTtlMs: 0 })).rejects.toBe(denial);
  expect(attempt).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
});
it("one cold editorial visitor stopping during retry cannot fail another visitor", async () => {
  enableQloo(); const a = new AbortController(); let first = true;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (first) { first = false; setTimeout(() => a.abort(), 30); return new Response("pause", { status: 429, headers: { "Retry-After": "0.15" } }); }
    return Response.json({ results: [] });
  });
  const scope = `editorial:${crypto.randomUUID()}`, ac = vi.fn(async () => {}), bc = vi.fn(async () => {});
  const query = { query: "synthetic editorial", types: ["urn:entity:movie" as const] };
  const results = await Promise.allSettled([client(scope, ac).searchEntities(query, { signal: a.signal }), client(scope, bc).searchEntities(query)]);
  expect(results[0].status).toBe("rejected"); expect(results[1].status).toBe("fulfilled");
  expect(ac).toHaveBeenCalledTimes(1); expect(bc).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  const warm = vi.fn(async () => {}); expect((await client(scope, warm).searchEntities(query)).provenance.cache).toBe("hit"); expect(warm).not.toHaveBeenCalled();
});

it("a selective receipt-index outage never falls back to the original gift", async () => {
  const { share } = await shared(), get = memory.get.bind(memory);
  vi.spyOn(memory, "get").mockImplementation(async (key) => {
    if (key === receiptIndexKey("reader", share)) throw new Error("Receipt storage unavailable");
    return get(key);
  });
  await expect(existingGift(share, "reader")).rejects.toMatchObject({ status: 503 });
  expect((await existingGift(share)).slots).toEqual(share.revision.slots);
});
it("saved originals survive replacement, undo, reload and explicit unsave", async () => {
  const { token, gift } = await shared();
  const original = gift.slots.find((slot) => slot.kind === "book")!;
  let next = await receiptAction(gift.receiptId!, "reader", { action: "save", slotId: "book", expectedVersion: gift.version! });
  const run = await startRun({ action: "repair", receiptRef: next.receiptId!, slotId: "book", expectedVersion: next.version!, idempotencyKey: crypto.randomUUID() }, "reader", "ip");
  await executeRun(run.run, run.draft!, () => {});
  next = await openReceipt(token, "reader");
  expect(next.slots.find((slot) => slot.kind === "book")!.entity.id).not.toBe(original.entity.id);
  expect(next.savedSlots).toEqual([original]);
  expect((await openReceipt(token, "forwarded-reader")).savedSlots).toEqual([]);
  await expect(receiptAction(next.receiptId!, "reader", { action: "unsave", slotId: "book", savedEntityId: "unseen", expectedVersion: next.version! })).rejects.toMatchObject({ status: 404 });
  next = await receiptAction(next.receiptId!, "reader", { action: "undo", slotId: "book", expectedVersion: next.version! });
  expect(next.savedSlots).toEqual([original]);
  next = await receiptAction(next.receiptId!, "reader", { action: "unsave", slotId: "book", savedEntityId: original.entity.id, expectedVersion: next.version! });
  expect(next.savedSlots).toEqual([]);
});
