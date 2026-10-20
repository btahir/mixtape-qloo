import "server-only";
import seeds from "./editorial-seeds.json";
import { liveSampleSchema } from "./sample-manifest";
import { comparisonSchema, evaluateCase, freezeEvaluationInput } from "./comparison";
import { samples, comparisonCases, sampleDraft } from "../samples";
import { type Draft, type Entity } from "../domain";
import { client, projectEntity } from "./qloo";
import { demoContentAllowed } from "../qloo/normalize";
import { SelectionTools } from "../agent/tools";
import { executionMode, modelId, runSelection } from "../agent";
import { provisionAllowance, reserve, settle } from "./limits";
import { DAY, MONTH, read, store, withRequestDeadline, type Store } from "./store";
import { hash, opaque } from "./security";
import { withReleaseBudget, type ReleaseBudget } from "./release-budget";

// No SQL schema exists: all durable application records live in Valkey.
// Future additive, idempotent migrations belong here, before quota provisioning.
export const migrations: { id: string; run: (s: Store) => Promise<void> }[] = [];
export async function migrate(s: Store) {
  for (const migration of migrations) {
    const key = `release:migration:${migration.id}`;
    if (await s.get(key)) continue;
    await migration.run(s);
    await s.cas(key, null, "done", 365 * DAY);
  }
}
function draftFor(id: string, manifest: Pick<Draft, "shelf" | "tastes">): Draft {
  return {
    id: `release-${id}`, owner: `release-${id}`, categories: ["movie", "book", "artist"],
    known: [], shared: [], excluded: [], revisions: [], version: 0, declaredBy: "sender",
    shareIds: [], updatedAt: new Date().toISOString(), expiresAt: Date.now() + MONTH,
    deleted: false, ...sampleDraft(id, "editorial-warmer"), ...manifest, mode: "live",
  };
}
async function prepareSample(id: keyof typeof seeds) {
  const original = sampleDraft(id, "editorial-warmer");
  const seed = seeds[id];
  const response = await client("release-hydration").getEntities({ entity_ids: [...new Set([...seed.shelf, ...seed.tastes].map((e) => e.id))] });
  const entities = new Map<string, Entity>();
  for (const raw of response.data.results) {
    if (!demoContentAllowed(raw)) continue;
    const entity = projectEntity(raw, "live", response.provenance.fetchedAt);
    if (entity) { delete entity.description; entities.set(entity.id.toUpperCase(), entity); }
  }
  function resolve(seed: { id: string; kind: string }) {
    const entity = entities.get(seed.id.toUpperCase());
    if (!entity || entity.kind !== seed.kind) throw new Error("Reviewed identity unavailable.");
    return entity;
  }
  const manifest = liveSampleSchema.parse({
    sampleId: id,
    shelf: original.shelf.map((entry, i) => ({ ...entry, entity: resolve(seed.shelf[i]) })),
    tastes: seed.tastes.map(resolve), validatedAt: new Date().toISOString(),
    // These identities were editorially reviewed for repair and responsiveness.
    // The live selection below must also succeed before publishing this sample.
    coverageConfirmed: true, repairConfirmed: true, signalResponsivenessConfirmed: true,
  });
  const draft = draftFor(id, manifest);
  const identities = JSON.stringify({ shelf: draft.shelf.map((e) => [e.entity.id, e.entity.kind]), tastes: draft.tastes.map((e) => [e.id, e.kind]) });
  const runId = `${new Date().toISOString().slice(0, 10)}:release:${opaque()}`;
  await reserve(runId, draft.owner, true);
  try {
    const tools = new SelectionTools(draft, client(`editorial:v1:${id}:${hash(identities)}`), AbortSignal.timeout(45000), async () => {}, async () => {});
    const result = await runSelection(tools);
    if (result.status !== "ready" || result.slots.length !== 3 || result.slots.some((s) => s.method !== "qloo" || s.evidence.score === null))
      throw new Error("Sample selection unavailable.");
  } finally { await settle(runId, undefined); }
  return manifest;
}
export async function warmRelease(s: Store, report: ReleaseReport) {
  if (!process.env.QLOO_API_KEY || !process.env.ANTHROPIC_API_KEY || process.env.QLOO_MODE === "fixture" ||
      process.env.QLOO_DEV_CACHE_DIR || modelId() !== "claude-haiku-5-5" || executionMode() !== "anthropic")
    throw new Error("Live release providers unavailable.");
  const drafts = new Map<string, Draft>();
  for (const sample of samples) {
    try {
      let manifest = await read(`live-sample:${sample.id}`, liveSampleSchema, s);
      if (!manifest) {
        manifest = await withRequestDeadline(60000, () => prepareSample(sample.id as keyof typeof seeds));
        await s.cas(`live-sample:${sample.id}`, null, JSON.stringify(manifest), MONTH);
        report.installedSamples++;
      } else report.skippedSamples++;
      drafts.set(sample.id, draftFor(sample.id, manifest));
    } catch { report.unavailable.push(sample.id); }
  }
  for (const c of comparisonCases) {
    try {
      const versionRaw = await s.get(`comparison-current:${c.id}`);
      const version = versionRaw ? JSON.parse(versionRaw) : null;
      if (version && await read(`comparison:${c.id}:${version}`, comparisonSchema, s)) { report.skippedComparisons++; continue; }
      const draft = structuredClone(drafts.get(c.id) ?? drafts.get("quiet-evenings"));
      if (!draft) throw new Error("Sample unavailable.");
      if (c.id === "quiet-evenings-other-tastes") {
        const piranesi = drafts.get("stranger-worlds")?.tastes.find((e) => e.id.toUpperCase() === seeds["stranger-worlds"].tastes[1].id.toUpperCase());
        if (!piranesi) throw new Error("Alternative taste unavailable.");
        draft.tastes[1] = piranesi;
      } else if (c.id === "known-low-coverage") {
        draft.known = draft.shelf.filter((e) => e.entity.kind === "book").map((e) => e.entity.id);
      } else if (!drafts.has(c.id)) throw new Error("Sample unavailable.");
      await withRequestDeadline(100000, async () => {
        await freezeEvaluationInput(c.id, draft);
        await evaluateCase(c.id, draft, `release-evaluation:${c.id}`, `release-evaluation:${c.id}`, { resumeInterrupted: true });
      });
      report.installedComparisons++;
    } catch { report.unavailable.push(c.id); }
  }
}
export type ReleaseReport = {
  installedSamples: number; skippedSamples: number; installedComparisons: number;
  skippedComparisons: number; unavailable: string[]; budget: ReleaseBudget;
};
export async function runRelease(s: Store = store(), warm = warmRelease) {
  await withRequestDeadline(10000, async () => { await migrate(s); await provisionAllowance(s); });
  const budget = { qloo: 0, modelMicroUsd: 0, deadline: Date.now() + 8 * 60000 };
  const report: ReleaseReport = { installedSamples: 0, skippedSamples: 0, installedComparisons: 0, skippedComparisons: 0, unavailable: [], budget };
  // Tiffin serializes releases; also guard manual/concurrent invocations.
  const lock = opaque();
  if (!await s.cas("release:warm-lock", null, lock, 9 * 60000)) {
    report.unavailable.push("warming-already-running"); return report;
  }
  try {
    await withReleaseBudget(budget, () => withRequestDeadline(8 * 60000, () => warm(s, report)));
  } catch { report.unavailable.push("warming-unavailable"); }
  finally {
    // CAS cannot remove a successor's lock if this process exceeded its lease.
    await s.cas("release:warm-lock", lock, "finished", 1).catch(() => {});
  }
  return report;
}
