import { beforeEach, expect, it, vi } from "vitest";
import { MemoryStore, store } from "@/lib/server/store";
import { createDraft, owned, createShare, mutateDraft, deleteDraft, publicShare } from "@/lib/server/repository";
import { executeRun, startRun } from "@/lib/server/runs";
import { current, type Draft } from "@/lib/domain";
import { SelectionTools } from "@/lib/agent/tools";
import { reserve, settle, ledgerKey } from "@/lib/server/limits";
let memory: MemoryStore;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic"); vi.restoreAllMocks();
  for (const key of ["QLOO_API_KEY", "ANTHROPIC_API_KEY", "TIFFIN_PROJECT", "REQUIRE_REDIS"]) vi.stubEnv(key, "");
  memory = new MemoryStore();
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = memory;
});
async function prepared() {
  const d = await createDraft("owner", "sample", "quiet-evenings");
  const r = await startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, "owner", "ip");
  await executeRun(r.run, r.draft!, () => {});
  return owned(d.id, "owner");
}
const share = (d: Draft) => createShare(d.id, "owner", { expectedVersion: d.version, idempotencyKey: crypto.randomUUID(), repairEnabled: true, approvedIds: d.shelf.map((e) => e.entity.id) });
it("invalidates only the changed shelf category before sharing", async () => {
  let d = await prepared();
  const extra = await createDraft("owner", "sample", "a-little-more-soul");
  d = await mutateDraft(d.id, "owner", d.version, (draft) => ({ ...draft, shelf: [...draft.shelf, extra.shelf[0]] }));
  expect(current(d)!.slots.map((s) => s.previousShelf)).toEqual([true, false, false]);
  await expect(share(d)).rejects.toThrow("Update their mixtape");
  d = await mutateDraft(d.id, "owner", d.version, (draft) => {
    current(draft)!.slots[0].locked = true; current(draft)!.slots[0].method = "human_lock"; return draft;
  });
  await expect(share(d)).resolves.toHaveProperty("token");
});
it("deletion tolerates expired shares and resumes after a failed dependent write", async () => {
  const d = await prepared();
  const first = await share(d);
  const latest = await owned(d.id, "owner");
  const second = await share(latest);
  await memory.del(`share:${first.share.id}`);
  const original = memory.cas.bind(memory);
  let fail = true;
  vi.spyOn(memory, "cas").mockImplementation(async (...args) => {
    if (args[0] === `share:${second.share.id}` && fail) { fail = false; throw Error("storage unavailable"); }
    return original(...args);
  });
  await expect(deleteDraft(d.id, "owner", (await owned(d.id, "owner")).version)).rejects.toThrow();
  await expect(publicShare(second.token)).rejects.toThrow();
  await expect(deleteDraft(d.id, "owner", d.version)).resolves.toEqual({ deleted: true });
  await expect(deleteDraft(d.id, "owner", d.version)).resolves.toEqual({ deleted: true });
  const erased = JSON.parse((await memory.get(`draft:${d.id}`))!);
  expect(erased.introduction).toBe(""); expect(erased.shelf).toHaveLength(0); expect(erased.revisions).toHaveLength(0);
  await expect(deleteDraft(d.id, "other", d.version)).rejects.toThrow();
});
it("completed fixture reservations leave a bounded ledger and cannot be replayed", async () => {
  for (let i = 0; i < 600; i++) {
    await reserve(`fixture-${i}`, "owner", false);
    await settle(`fixture-${i}`, 0);
  }
  const ledger = JSON.parse((await store().get(ledgerKey))!);
  expect(Object.keys(ledger.reservations)).toHaveLength(0);
  expect(Object.keys(ledger.leases)).toHaveLength(0);
  expect(JSON.stringify(ledger).length).toBeLessThan(250);
  await reserve("paid-id", "owner", true); await settle("paid-id", .005);
  await reserve("paid-id", "owner", true); await settle("paid-id", 0);
  expect(JSON.parse((await store().get(ledgerKey))!).total).toBeCloseTo(.005);
});
it("retains a safe top-level Qloo explanation failure", async () => {
  const d = await createDraft("owner", "sample", "quiet-evenings"); d.mode = "live";
  const q = { insights: async () => ({ data: { query: { explainability: { warning: "PRIVATE RAW WARNING" } }, results: { entities: d.shelf.filter((e) => e.entity.kind === "movie").map((e) => ({ entity_id: e.entity.id, name: e.entity.name, subtype: "urn:entity:movie" })) } }, provenance: { cache: "miss", fetchedAt: new Date().toISOString() } }) };
  const t = new SelectionTools(d, q as never, new AbortController().signal, async () => {}, async () => {});
  const reply = await t.rank("movie", d.version);
  const evidence = t.results.get(reply.ref!)!.evidence;
  expect(evidence.explanationStatus).toBe("failed");
  expect(evidence.warnings).toHaveLength(1);
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE RAW WARNING");
});
it("settlement storage stalls terminate after bounded cleanup without undoing a commit", async () => {
  const d = await createDraft("owner", "sample", "quiet-evenings");
  const r = await startRun({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, "owner", "ip");
  let committed = false;
  const batch = memory.batchCas.bind(memory), get = memory.get.bind(memory);
  vi.spyOn(memory, "batchCas").mockImplementation(async (...args) => {
    const result = await batch(...args);
    if (result && args[0].some((w) => w.key === `run:${r.run.id}` && JSON.parse(w.value).status === "ready")) committed = true;
    return result;
  });
  vi.spyOn(memory, "get").mockImplementation((key) => key === ledgerKey && committed ? new Promise(() => {}) : get(key));
  const started = Date.now();
  await executeRun(r.run, r.draft!, () => {});
  expect(Date.now() - started).toBeLessThan(3500);
  expect(current(await owned(d.id, "owner"))!.slots).toHaveLength(3);
});
it("comparison keeps both failed coverage arms and returns the existing record before spending", async () => {
  const { freezeEvaluationInput, evaluateCase } = await import("@/lib/server/comparison");
  for (const [key, value] of Object.entries({ ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_MODEL: "test/model", MODEL_POLICY_MODEL: "test/model", MODEL_COST_BOUND_CONFIRMED: "true", MODEL_BYTE_TOKEN_BOUND_CONFIRMED: "true", MODEL_INPUT_USD_PER_MILLION: ".1", MODEL_OUTPUT_USD_PER_MILLION: ".5" })) vi.stubEnv(key, value);
  const d = await createDraft("owner", "sample", "quiet-evenings"); d.mode = "live"; d.shelf = d.shelf.slice(0, 1);
  await freezeEvaluationInput("quiet-evenings", d);
  const result = await evaluateCase("quiet-evenings", d, "owner", "ip");
  expect(result.withQloo.failure).toContain("constraints");
  expect(result.withoutQloo.failure).toContain("constraints");
  const checkpoint = JSON.parse((await memory.get(`evaluation-run:quiet-evenings:${result.version}`))!);
  expect(checkpoint.withQloo.failure).toBeTruthy(); expect(checkpoint.withoutQloo.failure).toBeTruthy();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  expect(await evaluateCase("quiet-evenings", d, "owner", "ip")).toEqual(result);
  expect(await memory.get(ledgerKey)).toBeNull();
  // Simulate a release interrupted after checkpointing both arms but before publish.
  await memory.del(`comparison:quiet-evenings:${result.version}`);
  await memory.del("comparison-current:quiet-evenings");
  const resumed = await evaluateCase("quiet-evenings", d, "owner", "ip", { resumeInterrupted: true });
  expect(resumed.withQloo).toEqual(result.withQloo);
  expect(resumed.withoutQloo).toEqual(result.withoutQloo);
  expect(await memory.get(ledgerKey)).toBeNull();
  await memory.del("comparison-current:quiet-evenings");
  await evaluateCase("quiet-evenings", d, "owner", "ip", { resumeInterrupted: true });
  expect(JSON.parse((await memory.get("comparison-current:quiet-evenings"))!)).toBe(result.version);
});
