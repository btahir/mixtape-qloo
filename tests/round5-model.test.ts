import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APICallError, type LanguageModelV4CallOptions, type LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MemoryStore } from "@/lib/server/store";
import { createDraft, mutateDraft, owned } from "@/lib/server/repository";
import { executeRun, ownedRun, startRun } from "@/lib/server/runs";
import { dispatch } from "@/lib/server/api";
import { current, type Draft } from "@/lib/domain";
import type { SelectionTools } from "@/lib/agent/tools";
import * as agent from "@/lib/agent";
import { AppError } from "@/lib/server/errors";
import { QlooClient } from "@/lib/qloo/client";

// The actual ToolLoopAgent/Output parser executes; only provider transport is synthetic.
const provider = vi.hoisted(() => ({ generate: undefined as undefined | ((p: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>) }));
vi.mock("@ai-sdk/anthropic", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  return { createAnthropic: () => () => new MockLanguageModelV4({ doGenerate: async (p) => {
    if (!provider.generate) throw new Error("Missing synthetic provider script");
    return provider.generate(p);
  } }) };
});
vi.mock("@/lib/server/security", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/security")>();
  return { ...real, session: async () => "qa-model-owner" };
});

const owner = "qa-model-owner";
const originalRunSelection = agent.runSelection;
let memory: MemoryStore;
let active: SelectionTools;
let mode: "ready" | "failure-after-rank" | "402" | "invalid-final" | "premature-input" | "invalid-highlight" | "invalid-request";
let steps: number;
let rankCalls: number;
let network: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
  vi.restoreAllMocks();
  for (const key of ["QLOO_API_KEY", "QLOO_MODE", "QLOO_DEV_CACHE_DIR", "ANTHROPIC_API_KEY", "TIFFIN_PROJECT", "APP_ORIGIN", "PUBLIC_DEMO", "REQUIRE_REDIS", "REDIS_URL", "VALKEY_PREFIX", "PAUSE_GENERATION"])
    vi.stubEnv(key, "");
  vi.stubEnv("QLOO_SAMPLE_DIR", "nonexistent-synthetic-samples");
  memory = new MemoryStore();
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = memory;
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN_IN_REVIEWER_PROBES"));
  mode = "ready"; steps = 0; rankCalls = 0;
  vi.spyOn(agent, "runSelection").mockImplementation(async (tools) => {
    active = tools; steps = 0;
    return originalRunSelection(tools);
  });
  vi.spyOn(QlooClient.prototype, "insights").mockImplementation((async (params: Record<string, unknown>) => {
    rankCalls++;
    return {
      data: { results: { entities: (params["filter.results.entities"] as string[]).map((id) => ({
        entity_id: id, name: "Synthetic confirmed catalog row", subtype: params["filter.type"],
      })) } },
      provenance: { source: "qloo", cache: "miss", fetchedAt: new Date().toISOString(), elapsedMs: 1, attempts: 1, endpoint: "/v2/insights" },
    };
  }) as never);
  provider.generate = async (params) => {
    steps++;
    if (mode === "invalid-highlight" && steps === 3)
      expect(JSON.stringify(params.prompt)).toContain("A highlighted connection needs reported cross-category evidence.");
    if (mode === "invalid-request" && steps === 3)
      expect(JSON.stringify(params.prompt)).toContain("requestInput rejected");
    if (mode === "402") throw new APICallError({
      message: "Synthetic insufficient credits", url: "https://synthetic.invalid/anthropic",
      requestBodyValues: {}, statusCode: 402, isRetryable: false,
    });
    if (mode === "failure-after-rank" && steps > 1) throw new Error("Synthetic provider failure after successful ranking");
    const call = () => ({ type: "tool-call" as const, toolCallId: `${steps}-rank`, toolName: "rankNeededSlots", input: JSON.stringify({ revision: active.draft.version }) });
    const content = mode === "premature-input" ? [{ type: "text" as const, text: '{"status":"needs_input"}' }] : steps === 1
      ? [call()]
      : mode === "invalid-request" && steps === 2
        ? [{ type: "tool-call" as const, toolCallId: "clarify", toolName: "requestInput", input: JSON.stringify({ slotId: "movie", reason: "identity_missing" }) }]
      : !active.committed
        ? [{ type: "tool-call" as const, toolCallId: "commit", toolName: "commitDraft", input: JSON.stringify({ candidateRefs: [...active.refs.values()], ...(mode === "invalid-highlight" && steps === 2 ? { connections: [{ candidateRef: [...active.refs.values()][0], signalIndex: 0 }] } : {}) }) }]
        : [{ type: "text" as const, text: JSON.stringify({ status: mode === "invalid-final" ? "unapproved-value" : "ready" }) }];
    return { content, finishReason: { unified: active.committed ? "stop" : "tool-calls", raw: undefined },
      usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
  };
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
});

const input = (draft: Draft) => ({ action: current(draft) ? "refine" as const : "prepare" as const,
  draftId: draft.id, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() });
async function run(draft: Draft) {
  const started = await startRun(input(draft), owner, "qa-model-ip");
  await executeRun(started.run, started.draft!, () => {});
  return ownedRun(started.run.id, owner);
}
async function preparedLive() {
  let draft = await createDraft(owner, "fixture", "quiet-evenings");
  draft = await mutateDraft(draft.id, owner, draft.version, (value) => {
    const identities = new Map([...value.shelf.map((entry) => entry.entity), ...value.tastes].map((entity) => [entity.id, crypto.randomUUID()]));
    return { ...value, mode: "live", introduction: "Human words retained across failures.",
      shelf: value.shelf.map((entry) => ({ ...entry, entity: { ...entry.entity, id: identities.get(entry.entity.id)!, mode: "live" } })),
      tastes: value.tastes.map((entity) => ({ ...entity, id: identities.get(entity.id)!, mode: "live" })),
    };
  });
  for (const [key, value] of Object.entries({ QLOO_API_KEY: "synthetic-not-a-key", QLOO_EVENT_ACCESS_CONFIRMED: "true", QLOO_ACCESS_EXPIRES_AT: "2099-01-01T00:00:00Z", MIXTAPE_AGENT_MODE: "anthropic", ANTHROPIC_API_KEY: "synthetic-not-a-key", ANTHROPIC_MODEL: "test/model", MODEL_POLICY_MODEL: "test/model", MODEL_COST_BOUND_CONFIRMED: "true", MODEL_BYTE_TOKEN_BOUND_CONFIRMED: "true", MODEL_INPUT_USD_PER_MILLION: ".1", MODEL_OUTPUT_USD_PER_MILLION: ".5" })) vi.stubEnv(key, value);
  expect((await run(draft)).status).toBe("ready");
  expect(rankCalls).toBe(3);
  return owned(draft.id, owner);
}
function unchanged(before: Draft, after: Draft) {
  expect(after.version).toBe(before.version);
  expect(after.revisions).toEqual(before.revisions);
  expect(after.shelf).toEqual(before.shelf);
  expect(after.introduction).toBe(before.introduction);
}

it("actual SDK model failure after a successful Qloo ranking batch leaves the committed gift and human words unchanged", async () => {
  const before = await preparedLive();
  mode = "failure-after-rank";
  const ranksBefore = rankCalls;
  const result = await run(before);
  expect(rankCalls - ranksBefore).toBe(3);
  expect(steps).toBe(2);
  expect(result.status).toBe("failed");
  expect(result.error).toBe("The agent could not finish this mixtape. Your last version is unchanged.");
  unchanged(before, await owned(before.id, owner));
});

it("SPEC Gateway 402 through the actual SDK and executeRun uses paused-generation copy", async () => {
  const before = await preparedLive();
  mode = "402";
  const ranksBefore = rankCalls;
  const result = await run(before);
  expect(result.status).toBe("failed");
  expect(rankCalls).toBe(ranksBefore);
  unchanged(before, await owned(before.id, owner));
  expect(result.error).toBe("New mixtapes are paused for now. Saved links still work.");
});

it("actual SDK stops after validated commit without buying a formatting-only final turn", async () => {
  const before = await preparedLive();
  mode = "invalid-final";
  const ranksBefore = rankCalls;
  const result = await run(before);
  expect(rankCalls - ranksBefore).toBe(3);
  expect(active.committed).toBe(true);
  expect(result.status).toBe("ready");
  expect(steps).toBe(2);
  expect((await owned(before.id, owner)).version).toBeGreaterThan(before.version);
});

it.each(["invalid-highlight", "invalid-request"] as const)("compact state retains %s feedback so the model can correct without ranking again", async (rejectedMode) => {
  const before = await preparedLive();
  mode = rejectedMode;
  const ranksBefore = rankCalls;
  const result = await run(before);
  expect(result.status).toBe("ready");
  expect(rankCalls - ranksBefore).toBe(3);
  expect(steps).toBe(3);
  expect(active.toolFeedback).toBeNull();
});

it("SPEC share persistence failure through API dispatch returns share-specific recovery and publishes nothing", async () => {
  const before = await preparedLive();
  const original = memory.batchCas.bind(memory);
  let attempted = false;
  vi.spyOn(memory, "batchCas").mockImplementation(async (writes, deadline) => {
    if (writes.some((write) => write.key.startsWith("share:"))) {
      attempted = true;
      throw new Error("Synthetic storage transaction failure");
    }
    return original(writes, deadline);
  });
  const response = await dispatch(new Request(`http://localhost/api/drafts/${before.id}/shares`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ expectedVersion: before.version, idempotencyKey: crypto.randomUUID(), repairEnabled: true, approvedIds: before.shelf.map((entry) => entry.entity.id) }),
  }), ["drafts", before.id, "shares"]);
  const body = await response.json();
  expect(attempted).toBe(true);
  expect(response.status).toBe(503);
  expect(body).not.toHaveProperty("token");
  const after = await owned(before.id, owner);
  unchanged(before, after);
  expect(after.shareIds).toEqual(before.shareIds);
  expect(body.error).toBe("The link was not created. Your draft is still here.");
});

it("actual run commit storage failure after complete SDK selection preserves the prior persisted version", async () => {
  const before = await preparedLive();
  const original = memory.batchCas.bind(memory);
  let attempts = 0;
  vi.spyOn(memory, "batchCas").mockImplementation(async (writes, deadline) => {
    if (writes.some((write) => write.key === `draft:${before.id}`) && writes.some((write) => write.key.startsWith("run:"))) {
      attempts++;
      throw new Error("Synthetic final atomic commit unavailable");
    }
    return original(writes, deadline);
  });
  const result = await run(before);
  expect(attempts).toBe(1);
  expect(active.committed).toBe(true);
  expect(result.status).toBe("failed");
  unchanged(before, await owned(before.id, owner));
});

it("premature model abstention fails without telling the user to change valid inputs", async () => {
  const before = await preparedLive(); mode = "premature-input";
  const result = await run(before);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("agent could not finish");
  unchanged(before, await owned(before.id, owner));
});

it("terminal transport contention stops after one model step and preserves the typed busy outcome", async () => {
  const before = await preparedLive();
  vi.spyOn(QlooClient.prototype, "insights").mockRejectedValue(new AppError(429, "Mixtape is busy right now. Your draft is saved.", 2));
  const result = await run(before);
  expect(result.status).toBe("failed");
  expect(result.failure?.status).toBe(429);
  expect(result.error).toBe("Mixtape is busy right now. Your draft is saved.");
  expect(steps).toBe(1);
  unchanged(before, await owned(before.id, owner));
});
