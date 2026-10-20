import { beforeEach, expect, it, vi } from "vitest";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MemoryStore, read, store, update, withStoreDeadline, DAY } from "@/lib/server/store";
import { createDraft, owned, saveDraft, undoDraft, createShare } from "@/lib/server/repository";
import { executeRun, startRun, ownedRun } from "@/lib/server/runs";
import { current, runSchema, type Draft, type Kind } from "@/lib/domain";
import { SelectionTools } from "@/lib/agent/tools";
import { runSelection } from "@/lib/agent";
import { QlooError } from "@/lib/qloo/errors";
import { qlooFailure, search } from "@/lib/server/qloo";
import { QlooClient, QLOO_ORIGIN } from "@/lib/qloo/client";
import { validateBaseline } from "@/lib/server/comparison";
import { changedWords, applyWords, wordConflicts } from "@/lib/draft-text";
import { verifyDeployment } from "@/lib/server/deployment";
const script = vi.hoisted(() => ({ generate: undefined as undefined | ((p: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>) }));
vi.mock("@ai-sdk/anthropic", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  return { createAnthropic: () => () => new MockLanguageModelV4({ doGenerate: async (p) => {
    if (!script.generate) throw Error("Unexpected model call");
    return script.generate(p);
  } }) };
});
let memory: MemoryStore;
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
  vi.restoreAllMocks();
  for (const key of ["QLOO_API_KEY", "ANTHROPIC_API_KEY", "TIFFIN_PROJECT", "APP_ORIGIN", "PUBLIC_DEMO"]) vi.stubEnv(key, "");
  vi.stubEnv("QLOO_SAMPLE_DIR", ".qa/unit-empty-samples");
  memory = new MemoryStore();
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = memory;
  script.generate = undefined;
});
const input = (d: Draft, slotId?: Kind) => ({ action: slotId ? "repair" as const : "prepare" as const,
  draftId: d.id, slotId, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() });
async function prepared() {
  const d = await createDraft("A", "sample", "quiet-evenings");
  const r = await startRun(input(d), "A", "ip");
  await executeRun(r.run, r.draft!, () => {});
  return owned(d.id, "A");
}
function modelPolicy() {
  for (const [k, v] of Object.entries({ MIXTAPE_AGENT_MODE: "anthropic", ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_MODEL: "test/model", MODEL_POLICY_MODEL: "test/model", MODEL_COST_BOUND_CONFIRMED: "true", MODEL_BYTE_TOKEN_BOUND_CONFIRMED: "true", MODEL_INPUT_USD_PER_MILLION: ".1", MODEL_OUTPUT_USD_PER_MILLION: ".5" })) vi.stubEnv(k, v);
}
it.each([false, true])("real SDK completes realistic UUID catalog, corrective=%s, within every input gate", async (corrective) => {
  modelPolicy();
  const d = structuredClone(await createDraft("A", "sample", "quiet-evenings"));
  d.mode = "live";
  for (const e of [...d.shelf.map((s) => s.entity), ...d.tastes]) {
    e.mode = "live"; e.id = crypto.randomUUID();
    e.description = "Untrusted catalog metadata. ".repeat(40);
  }
  let calls = 0;
  const q = { getEntities: vi.fn(), insights: vi.fn(async (p: Record<string, unknown>) => {
    calls++;
    return { data: { results: { entities: (p["filter.results.entities"] as string[]).map((id, i) => ({
      entity_id: id, name: "Catalog row", subtype: corrective && calls === 1 && i === 0 ? "urn:entity:book" : p["filter.type"],
    })) } }, provenance: { fetchedAt: new Date().toISOString(), cache: "miss" } };
  }) };
  const t = new SelectionTools(d, q as never, new AbortController().signal, async () => {}, async () => {});
  let step = 0;
  script.generate = async (params) => {
    expect(JSON.stringify(params)).not.toContain("Untrusted catalog");
    step++;
    if (!t.committed && !t.clarification) {
      expect(params.toolChoice).toEqual({ type: "required" });
      expect(params.tools!.filter((tool) => tool.type === "function").length).toBeGreaterThanOrEqual(2);
    }
    if (step > 1 && ![...t.outcomes.values()].some((outcome) => outcome.retryAllowed))
      expect(params.tools?.some((tool) => tool.name === "rankNeededSlots")).toBeFalsy();
    const call = () => ({ type: "tool-call" as const, toolCallId: `${step}-rank`, toolName: "rankNeededSlots", input: JSON.stringify({ revision: d.version }) });
    const retry = [...t.outcomes].find(([, r]) => r.retryAllowed);
    const content = step === 1 ? [call()] : retry ? [call()] : !t.committed ? [{
      type: "tool-call" as const, toolCallId: "commit", toolName: "commitDraft", input: JSON.stringify({ candidateRefs: [...t.refs.values()] }),
    }] : [{ type: "text" as const, text: JSON.stringify({ status: "ready" }) }];
    return { content, finishReason: { unified: t.committed ? "stop" : "tool-calls", raw: undefined },
      usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
  };
  const result = await runSelection(t);
  expect(result.status).toBe("ready");
  expect(result.slots).toHaveLength(3);
  expect(step).toBe(corrective ? 3 : 2);
  expect(Math.max(...t.audit.inputBounds)).toBeLessThanOrEqual(8000);
  expect(t.audit.steps).toHaveLength(step);
  expect(q.insights).toHaveBeenCalledTimes(corrective ? 4 : 3);
});
it("live mode with deterministic fallback still requires a real Qloo client", async () => {
  const d = structuredClone(await createDraft("A", "fixture", "quiet-evenings")); d.mode = "live";
  const t = new SelectionTools(d, null, new AbortController().signal, async () => {}, async () => {});
  await expect(runSelection(t)).rejects.toThrow("cannot reach Qloo");
  expect(t.toolCalls).toBe(1);
});
it("undo targets the last replacement and retains later human notes and locks", async () => {
  let d = await prepared();
  const original = current(d)!;
  const film = original.slots[0];
  d = await saveDraft(d.id, "A", { expectedVersion: d.version, notes: { [film.entity.id]: "My new note" } });
  await expect(undoDraft(d.id, "A", d.version)).rejects.toThrow("no replacement");
  const r = await startRun(input(d, "book"), "A", "ip"); await executeRun(r.run, r.draft!, () => {});
  d = await owned(d.id, "A");
  d = await saveDraft(d.id, "A", { expectedVersion: d.version, notes: { [film.entity.id]: "My newest words" }, lock: { kind: "movie", locked: true } });
  d = await undoDraft(d.id, "A", d.version);
  expect(current(d)!.slots[1].entity.id).toBe(original.slots[1].entity.id);
  expect(current(d)!.slots[0].note).toBe("My newest words");
  expect(current(d)!.slots[0].locked).toBe(true);
  expect(d.shelf.find((e) => e.entity.id === film.entity.id)!.note).toBe("My newest words");
});
it("changed format cannot share an incompatible revision with the same count", async () => {
  let d = await createDraft("A", "sample", "quiet-evenings");
  d = await saveDraft(d.id, "A", { expectedVersion: d.version, categories: ["movie", "book"] });
  const r = await startRun(input(d), "A", "ip"); await executeRun(r.run, r.draft!, () => {});
  d = await owned(d.id, "A");
  d = await saveDraft(d.id, "A", { expectedVersion: d.version, categories: ["movie", "artist"] });
  await expect(createShare(d.id, "A", { expectedVersion: d.version, idempotencyKey: crypto.randomUUID(), repairEnabled: false, approvedIds: [] })).rejects.toThrow("Make their mixtape");
});
it("matched baseline enforces locks and exact ordered categories", async () => {
  let d = await prepared();
  d = await saveDraft(d.id, "A", { expectedVersion: d.version, lock: { kind: "movie", locked: true } });
  const selected = current(d)!.slots.map((s) => ({ kind: s.kind, entityId: s.entity.id }));
  expect(validateBaseline(d, selected)).toEqual(selected);
  expect(() => validateBaseline(d, [...selected].reverse())).toThrow();
  selected[0].entityId = d.shelf.find((e) => e.entity.kind === "movie" && e.entity.id !== selected[0].entityId)!.entity.id;
  expect(() => validateBaseline(d, selected)).toThrow();
});
it.each(["missing", "wrong-kind"])("hydrated %s identities cannot rank or commit", async (condition) => {
  const d = structuredClone(await createDraft("A", "fixture", "quiet-evenings")); d.mode = "live";
  const id = d.shelf[0].entity.id;
  const t = new SelectionTools(d, { getEntities: vi.fn(async () => ({ data: { results: condition === "missing" ? [] : [{ entity_id: id, subtype: "urn:entity:book" }] } })),
    insights: vi.fn(async (p) => ({ data: { results: { entities: (p["filter.results.entities"] as string[]).map((id) => ({ entity_id: id, subtype: "urn:entity:movie" })) } }, provenance: { cache: "miss", fetchedAt: "now" } })),
  } as never, new AbortController().signal, async () => {}, async () => {});
  expect((await t.hydrate([id])).status).toBe("needs_input");
  const ranked = await t.rank("movie", d.version);
  expect(t.results.get(ranked.ref!)?.entity.id).not.toBe(id);
  await expect(t.commit([...t.refs.values()])).rejects.toThrow("Add another favourite");
});
it("unknown-reset 429 never retries, while search-specific 404 is an empty list", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 429 }));
  const q = new QlooClient({ origin: QLOO_ORIGIN, apiKey: "synthetic", transport: { mode: "live", fetch } });
  await expect(q.searchEntities({ query: "missing" })).rejects.toMatchObject({ kind: "rate_limit" });
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.stubEnv("QLOO_API_KEY", "synthetic"); vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 404 }));
  expect(await search("missing", "movie", "live", "A")).toEqual([]);
});
it.each(["timeout", "network", "upstream"] as const)("adapter preserves %s recovery", (kind) => {
  const error = qlooFailure(new QlooError(kind, "private provider detail"));
  expect(error.message).toBe(kind === "timeout" ? "This is taking longer than it should. Your draft is safe." : "Qloo is unavailable right now. Your current mixtape is still here.");
});
it("terminal counts are per slot across corrective attempts", async () => {
  const d = await createDraft("A", "sample", "quiet-evenings");
  // Exercise the run event collector with actual tools while forcing a changed subset.
  const agent = await import("@/lib/agent");
  const original = agent.runSelection;
  vi.spyOn(agent, "runSelection").mockImplementation(async (t) => {
    await t.event("tool_completed", "First film check", "movie", "retry_pending");
    await t.event("tool_completed", "Second film check", "movie", "slot_checked");
    await t.event("needs_input", "Blocked book", "book");
    await t.event("needs_input", "Still blocked book", "book");
    return original(t);
  });
  const start = await startRun(input(d), "A", "ip");
  const completed: number[] = [];
  await executeRun(start.run, start.draft!, (e) => { if (e.label.includes("check") || e.label.includes("book")) completed.push(e.completed!); });
  expect(completed.slice(0, 4)).toEqual([0, 1, 2, 2]);
});
it("cancel recorded by a different executor aborts the active tool transport", async () => {
  const d = await createDraft("A", "sample", "quiet-evenings");
  const start = await startRun(input(d), "A", "ip");
  let aborted = false;
  const agent = await import("@/lib/agent");
  vi.spyOn(agent, "runSelection").mockImplementation(async (t) => {
    await update(`run:${start.run.id}`, runSchema, (r) => ({ ...r!, cancelled: true }), DAY);
    await new Promise<void>((resolve) => t.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    t.signal.throwIfAborted();
    throw Error("unreachable");
  });
  await executeRun(start.run, start.draft!, () => {});
  expect(aborted).toBe(true);
  expect((await ownedRun(start.run.id, "A")).status).toBe("cancelled");
  expect(current(await owned(d.id, "A"))).toBeUndefined();
});
it("storage waiting and atomic late writes obey remaining deadline", async () => {
  const controller = new AbortController();
  vi.spyOn(memory, "get").mockImplementationOnce(() => new Promise(() => {}));
  const pending = withStoreDeadline(controller.signal, Date.now() + 1000, () => store().get("stall"));
  controller.abort(); await expect(pending).rejects.toBeDefined();
  expect(await memory.batchCas([{ key: "late", old: null, value: "bad", ttlMs: DAY }], Date.now() - 1)).toBe(false);
  expect(await read("late", runSchema)).toBeNull();
});
it("two-tab word reapplication never overwrites a field the stale tab did not edit", async () => {
  const base = await createDraft("A", "sample", "quiet-evenings");
  const stale = { ...base, introduction: "Only my line changed" };
  const latest = { ...base, sender: "Newer sender", shelf: base.shelf.map((e) => ({ ...e, note: "A newer note" })) };
  const words = changedWords(base, stale);
  expect(wordConflicts(base, latest, words)).toEqual([]);
  const merged = applyWords(latest, words);
  expect(merged.sender).toBe("Newer sender");
  expect(merged.shelf).toEqual(latest.shelf);
  expect(merged.introduction).toBe("Only my line changed");
  expect(wordConflicts(base, { ...latest, introduction: "Also edited" }, words)).toEqual(["A line from you"]);
});
it("public profiles cannot use disposable local defaults", () => {
  vi.stubEnv("PUBLIC_DEMO", "true");
  expect(() => verifyDeployment()).toThrow("not configured");
});
it("factory searches share one flight while subscriber cancellation stays independent", async () => {
  vi.stubEnv("QLOO_API_KEY", "synthetic"); vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true"); vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await gate; return new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } });
  });
  const { client } = await import("@/lib/server/qloo");
  const controller = new AbortController();
  const first = client("search:owner-A").searchEntities({ query: "shared public catalog" }, { signal: controller.signal });
  const second = client("search:owner-B").searchEntities({ query: "shared public catalog" });
  controller.abort();
  await expect(first).rejects.toMatchObject({ kind: "cancelled" });
  release();
  expect((await second).data.results).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("comparison inputs are immutable and include metadata, locks and exclusions", async () => {
  const { freezeEvaluationInput } = await import("@/lib/server/comparison");
  const d = structuredClone(await createDraft("A", "fixture", "quiet-evenings")); d.mode = "live";
  const frozen = await freezeEvaluationInput("quiet-evenings", d);
  expect(await freezeEvaluationInput("quiet-evenings", d)).toEqual(frozen);
  d.tastes[0].description = "Different frozen catalog data";
  await expect(freezeEvaluationInput("quiet-evenings", d)).rejects.toThrow("different frozen input");
});
it.each([false, true])("safe warning projection distinguishes empty arrays from real warnings (%s)", async (warn) => {
  const d = structuredClone(await createDraft("A", "fixture", "quiet-evenings")); d.mode = "live";
  const t = new SelectionTools(d, { getEntities: vi.fn(), insights: vi.fn(async (p) => ({
    data: { warnings: warn ? ["private unused entity metadata"] : [], results: { entities: (p["filter.results.entities"] as string[]).map((id) => ({ entity_id: id, name: "Catalog row", subtype: "urn:entity:movie", query: { explainability: { warning: "" } } })) } },
    provenance: { cache: "miss", fetchedAt: new Date().toISOString() },
  })) } as never, new AbortController().signal, async () => {}, async () => {});
  const result = await t.rank("movie", d.version);
  const warnings = t.results.get(result.ref!)!.evidence.warnings;
  expect(warnings).toHaveLength(warn ? 1 : 0);
  expect(JSON.stringify(warnings)).not.toContain("private unused");
});
it.each([false, true])("matched evaluator checkpoints both arms including denied second admission=%s", async (deniedSecond) => {
  modelPolicy();
  vi.stubEnv("QLOO_API_KEY", "synthetic");
  vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true");
  vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
  const { freezeEvaluationInput, evaluateCase } = await import("@/lib/server/comparison");
  const d = structuredClone(await createDraft("A", "fixture", "quiet-evenings")); d.mode = "live";
  for (const e of [...d.shelf.map((s) => s.entity), ...d.tastes]) { e.mode = "live"; e.id = crypto.randomUUID(); }
  const selections = d.categories.map((kind) => ({ kind, entityId: d.shelf.find((s) => s.entity.kind === kind)!.entity.id }));
  vi.spyOn(QlooClient.prototype, "insights").mockImplementation(async (params) => ({ data: { results: { entities: (params["filter.results.entities"] as string[]).map((id) => ({ entity_id: id, name: "Confirmed", subtype: params["filter.type"] })) } }, provenance: { source: "qloo", cache: "miss", fetchedAt: new Date().toISOString(), elapsedMs: 1, attempts: 1, endpoint: "/v2/insights" } }) as never);
  let qlooStep = 0, baselineStep = 0;
  script.generate = async (params) => {
    const isBaseline = JSON.stringify(params.tools ?? []).includes("validateChoices");
    const step = isBaseline ? ++baselineStep : ++qlooStep;
    let content: LanguageModelV4GenerateResult["content"];
    if (isBaseline) {
      expect(params.toolChoice).toEqual({ type: step <= 2 ? "required" : "none" });
      content = step <= 2 ? [{ type: "tool-call", toolCallId: `b-${step}`, toolName: "validateChoices", input: JSON.stringify({ choices: step === 1 ? [] : selections }) }] : [{ type: "text", text: JSON.stringify({ choices: selections }) }];
    } else if (step === 1) {
      content = [{ type: "tool-call" as const, toolCallId: "rank", toolName: "rankNeededSlots", input: JSON.stringify({ revision: d.version }) }];
    } else if (step === 2) {
      const user = params.prompt.findLast((p) => p.role === "user")!;
      const state = JSON.parse((user.content as { type: string; text?: string }[]).find((part) => part.type === "text")!.text!);
      content = [{ type: "tool-call", toolCallId: "commit", toolName: "commitDraft", input: JSON.stringify({ candidateRefs: state.slots.map((s: { outcome: { ref: string } }) => s.outcome.ref) }) }];
    } else content = [{ type: "text", text: '{"status":"ready"}' }];
    return { content, finishReason: { unified: step < 3 ? "tool-calls" : "stop", raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
  };
  if (deniedSecond) {
    const { counter } = await import("@/lib/server/limits");
    await counter("inference:0:A", 3, 60000); await counter("inference:0:A", 3, 60000);
  }
  await freezeEvaluationInput("quiet-evenings", d);
  const result = await evaluateCase("quiet-evenings", d, "A", "ip");
  expect(result.withQloo.failure).toBeNull();
  if (deniedSecond) {
    expect(result.withoutQloo.failure).toBeTruthy(); expect(baselineStep).toBe(0);
    expect(result.withoutQloo.reservedUsd).toBe(0);
  } else {
    expect(result.withoutQloo.failure).toBeNull();
    expect(result.withoutQloo.choices).toEqual(selections);
    expect(result.withoutQloo.audit!.steps).toHaveLength(3);
  }
  expect(result.config!.totalOutputTokens).toBe(4096);
  expect(JSON.parse((await memory.get(`evaluation-run:quiet-evenings:${result.version}`))!).withoutQloo.failure).toBe(result.withoutQloo.failure);
});

it("agent highlights only reported cross-category connections and never receives human wording", async () => {
  const { selectionState } = await import("@/lib/agent");
  const d = await createDraft("highlight-owner", "fixture", "quiet-evenings");
  d.sender = "PRIVATE SENDER"; d.introduction = "PRIVATE LETTER";
  d.shelf.forEach((e) => { e.note = "PRIVATE NOTE"; });
  const t = new SelectionTools(d, null, new AbortController().signal, async () => {}, async () => {});
  const result = await t.rank("book", d.version);
  const slot = t.results.get(result.ref!)!;
  slot.evidence.mode = "live";
  slot.evidence.explanationStatus = "verified";
  const filmIndex = slot.evidence.signals.findIndex((e) => e.kind === "movie");
  const bookIndex = slot.evidence.signals.findIndex((e) => e.kind === "book");
  slot.evidence.contributions = [{ entityId: slot.evidence.signals[filmIndex].id, score: .45 }];
  const state = JSON.stringify(selectionState(t));
  expect(state).toContain(slot.entity.name);
  expect(state).toContain(slot.evidence.signals[filmIndex].name);
  expect(state).not.toContain("PRIVATE");
  t.highlightConnections([{ candidateRef: result.ref!, signalIndex: filmIndex }]);
  expect(slot.evidence.highlightedSignalId).toBe(slot.evidence.signals[filmIndex].id);
  const interpretation = "imaginary cities told by Marco Polo";
  slot.entity.name = "Invisible Cities";
  t.highlightConnections([{ candidateRef: result.ref!, signalIndex: filmIndex, interpretation }]);
  expect(slot.evidence.readingDetail).toBe(interpretation);
  for (const bad of ["A claim about another work.", "Your taste for The Ocean at the End of the Lane opens a door to film: Spirited Away shares its dreamlike, child-led journey into a world just beside our own.", "Your taste for Sing Street pairs with The Little Prince."])
    expect(() => t.highlightConnections([{ candidateRef: result.ref!, signalIndex: filmIndex, interpretation: bad }])).toThrow("exact supplied detail");
  for (const choice of [{ candidateRef: "invented", signalIndex: filmIndex }, { candidateRef: result.ref!, signalIndex: bookIndex }, { candidateRef: result.ref!, signalIndex: 4 }])
    expect(() => t.highlightConnections([choice])).toThrow("reported cross-category evidence");
  slot.evidence.contributions[0].score = 0;
  expect(() => t.highlightConnections([{ candidateRef: result.ref!, signalIndex: filmIndex }])).toThrow();
});
