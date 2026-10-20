import { it, expect } from "vitest";
import {
  baselineContext,
  validateBaseline,
  evaluationManifest,
} from "@/lib/server/comparison";
import { sampleDraft } from "@/lib/samples";
import type { Draft } from "@/lib/domain";
const d = {
  id: "editorial",
  owner: "editor",
  ...sampleDraft("quiet-evenings", "editor"),
  categories: ["movie", "book", "artist"],
  known: [],
  shared: [],
  excluded: [],
  revisions: [],
  version: 0,
  declaredBy: "sender",
  shareIds: [],
  updatedAt: "now",
  expiresAt: 0,
  deleted: false,
} as Draft;
it("baseline gets identical candidate IDs with no affinity, ranking, notes or owner names", () => {
  const c = baselineContext(d),
    raw = JSON.stringify(c);
  for (const banned of [
    "affinity",
    "contribution",
    "evidence",
    "Maya",
    "Leo",
    d.introduction,
    d.shelf[0].note,
  ])
    expect(raw).not.toContain(banned);
  expect(c.allowed.map((e) => e.entityId)).toEqual(
    d.shelf.map((e) => e.entity.id),
  );
});
it("rejects out-of-shelf baseline choices and freezes five plus ten briefs", () => {
  expect(() =>
    validateBaseline(d, [{ kind: "book", entityId: "invented" }]),
  ).toThrow();
  expect(evaluationManifest.cases).toHaveLength(5);
  expect(evaluationManifest.heldOut).toHaveLength(10);
});
it("requires frozen input before either a model or deterministic comparison", async () => {
  const { vi } = await import("vitest");
  const { evaluateCase } = await import("@/lib/server/comparison");
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_MODEL", "test/model");
  vi.stubEnv("MODEL_POLICY_MODEL", "test/model");
  vi.stubEnv("MODEL_COST_BOUND_CONFIRMED", "true");
  vi.stubEnv("MODEL_BYTE_TOKEN_BOUND_CONFIRMED", "true");
  vi.stubEnv("MODEL_INPUT_USD_PER_MILLION", ".1");
  vi.stubEnv("MODEL_OUTPUT_USD_PER_MILLION", ".5");
  await expect(
    evaluateCase("quiet-evenings", { ...d, mode: "live" }, "editor", "test-ip"),
  ).rejects.toThrow("Freeze this confirmed input");
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
});
