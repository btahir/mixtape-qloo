import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { current, type Draft } from "@/lib/domain";
import { SelectionTools } from "@/lib/agent/tools";
import { createDraft, owned } from "@/lib/server/repository";
import { executeRun, ownedRun, startRun } from "@/lib/server/runs";
import { MemoryStore } from "@/lib/server/store";

// Reviewer-only acceptance probes. These use synthetic fixture identities and
// inject a valid empty ranking exactly as the shipped round6 receipt test does.
// No Qloo, Gateway, browser, or production storage is accessed.
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
  vi.restoreAllMocks();
  for (const key of [
    "QLOO_API_KEY", "ANTHROPIC_API_KEY", 
    "TIFFIN_PROJECT", "REQUIRE_REDIS", "PUBLIC_DEMO",
    "QLOO_DEV_CACHE_DIR", "QLOO_ORIGIN", "REDIS_URL",
    "VALKEY_PREFIX", "PAUSE_GENERATION",
  ]) vi.stubEnv(key, "");
  vi.stubEnv("QLOO_MODE", "fixture");
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = new MemoryStore();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Reviewer probe forbids network"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); });

function emptyRank() {
  return vi.spyOn(SelectionTools.prototype, "rank").mockImplementation(async function (this: SelectionTools, kind) {
    const outcome = { status: "empty" as const, eligible: 2, returned: 0, missing: 2, rejected: 0, retryAllowed: false };
    this.outcomes.set(kind, outcome);
    return outcome;
  });
}
async function prepare(draft: Draft) {
  const started = await startRun({ action: "prepare", draftId: draft.id, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() }, draft.owner, "reviewer-ip");
  await executeRun(started.run, started.draft!, () => {});
  expect((await ownedRun(started.run.id, draft.owner)).status).toBe("ready");
  return owned(draft.id, draft.owner);
}

it("SPEC 3.9: sender prepare rejects unchanged valid-empty input before a second inference admission", async () => {
  const draft = await createDraft("reviewer-owner", "fixture", "quiet-evenings");
  const rank = emptyRank();
  const input = () => ({ action: "prepare" as const, draftId: draft.id, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() });
  const first = await startRun(input(), draft.owner, "reviewer-ip");
  await executeRun(first.run, first.draft!, () => {});
  expect((await ownedRun(first.run.id, draft.owner)).status).toBe("needs_input");
  expect((await owned(draft.id, draft.owner)).version).toBe(draft.version);
  expect(rank).toHaveBeenCalledTimes(1);
  // Current r6 resolves with a new accepted run here: the receipt-only empty
  // marker does not protect sender drafts. A correct implementation rejects.
  await expect(startRun(input(), draft.owner, "reviewer-ip")).rejects.toThrow("Qloo did not return a choice");
});

it("SPEC 3.9: sender repair rejects unchanged valid-empty input and retains the committed gift", async () => {
  const draft = await prepare(await createDraft("reviewer-owner", "fixture", "quiet-evenings"));
  const prior = structuredClone(current(draft));
  const rank = emptyRank();
  const input = () => ({ action: "repair" as const, draftId: draft.id, slotId: "book" as const, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() });
  const first = await startRun(input(), draft.owner, "reviewer-ip");
  await executeRun(first.run, first.draft!, () => {});
  expect((await ownedRun(first.run.id, draft.owner)).status).toBe("needs_input");
  expect(current(await owned(draft.id, draft.owner))).toEqual(prior);
  expect(rank).toHaveBeenCalledTimes(1);
  await expect(startRun(input(), draft.owner, "reviewer-ip")).rejects.toThrow("Qloo did not return a choice");
});

it("empty sender outcome survives wording saves but allows changed ranking inputs", async () => {
  const { saveDraft } = await import("@/lib/server/repository");
  let d = await createDraft("owner", "fixture", "quiet-evenings");
  emptyRank();
  const first = await startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, d.owner, "ip");
  await executeRun(first.run, first.draft!, () => {});
  d = await saveDraft(d.id, d.owner, { expectedVersion: d.version, introduction: "My own words" });
  await expect(startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, d.owner, "ip")).rejects.toThrow("Qloo did not return a choice");
  const { mutateDraft } = await import("@/lib/server/repository");
  d = await mutateDraft(d.id, d.owner, d.version, (v) => ({ ...v, tastes: [...v.tastes].reverse() }));
  await expect(startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, d.owner, "ip")).resolves.toHaveProperty("run.status", "accepted");
});

it("draft listing uses one compact index read and rejects the 101st draft without hiding the first", async () => {
  const { listDrafts } = await import("@/lib/server/repository");
  const { store } = await import("@/lib/server/store");
  const drafts = [];
  for (let i = 0; i < 100; i++) drafts.push(await createDraft("owner", "fixture", "quiet-evenings"));
  const get = vi.spyOn(store(), "get");
  const list = await listDrafts("owner", 3);
  expect(list).toHaveLength(3); expect(get).toHaveBeenCalledTimes(1);
  expect(list[0]).not.toHaveProperty("shelf"); expect(list[0]).not.toHaveProperty("revisions");
  await expect(createDraft("owner", "empty")).rejects.toThrow("100 drafts");
  expect(await listDrafts("owner")).toHaveLength(100);
  expect(await owned(drafts[0].id, "owner")).toHaveProperty("id", drafts[0].id);
});

it("ordinary storage writes carry atomic deadlines and aborted requests admit no new write", async () => {
  const { store, withStoreDeadline } = await import("@/lib/server/store");
  const memory = store(), cas = vi.spyOn(memory, "cas");
  const controller = new AbortController(), deadline = Date.now() + 1000;
  await withStoreDeadline(controller.signal, deadline, () => store().cas("bounded", null, "ok", 1000));
  expect(cas).toHaveBeenLastCalledWith("bounded", null, "ok", 1000, deadline);
  controller.abort();
  await expect(withStoreDeadline(controller.signal, deadline, () => store().cas("late", null, "no", 1000))).rejects.toThrow();
  expect(await memory.get("late")).toBeNull();
});

it("editorial installation validates all inputs and publishes no partial set when warming fails", async () => {
  const { installEditorial } = await import("@/lib/server/install-editorial");
  const { store } = await import("@/lib/server/store");
  const { samples, comparisonCases } = await import("@/lib/samples");
  const manifests = await Promise.all(samples.map(async (s) => {
    const d = await createDraft(`editor:${s.id}`, "fixture", s.id);
    const live = (e: typeof d.tastes[number]) => ({ ...e, id: crypto.randomUUID(), mode: "live" });
    return { sampleId: s.id, shelf: d.shelf.map((e) => ({ ...e, entity: live(e.entity) })), tastes: d.tastes.map(live), validatedAt: new Date().toISOString(), coverageConfirmed: true, repairConfirmed: true, signalResponsivenessConfirmed: true };
  }));
  const arm = { choices: [], failure: "Synthetic control", latencyMs: 0, reservedUsd: 0, createdAt: "now", evidence: [] };
  const comparisons = comparisonCases.map((c) => ({ id: c.id, mode: "live", catalog: [], shelfIds: [], signalIds: [], excludedIds: [], locks: [], categories: ["movie", "book"], fingerprint: "synthetic", model: "deterministic-local-stub", method: "deterministic-ablation", configHash: "synthetic", metadataHash: "synthetic", withQloo: arm, withoutQloo: arm, createdAt: "now" }));
  const warm = vi.fn().mockResolvedValue(undefined).mockRejectedValueOnce(new Error("warm unavailable"));
  await expect(installEditorial(manifests, comparisons, store(), warm)).rejects.toThrow("warm unavailable");
  expect(await store().get("live-sample:quiet-evenings")).toBeNull();
  expect(await store().get("comparison-current:quiet-evenings")).toBeNull();
  const publish = vi.spyOn(store(), "batchCas");
  await installEditorial(manifests, comparisons, store(), warm);
  expect(publish).toHaveBeenCalledTimes(1); expect(publish.mock.calls[0][0]).toHaveLength(13);
  expect(await store().get("live-sample:quiet-evenings")).not.toBeNull();
  const version = JSON.parse((await store().get("comparison-current:quiet-evenings"))!);
  expect(await store().get(`comparison:quiet-evenings:${version}`)).not.toBeNull();
});
