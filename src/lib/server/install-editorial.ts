import "server-only";
import { liveSampleSchema } from "./sample-manifest";
import { comparisonSchema } from "./comparison";
import { samples, comparisonCases, sampleDraft } from "../samples";
import { SelectionTools } from "../agent/tools";
import { client } from "./qloo";
import { MONTH, store, type Store, type Write } from "./store";
import { hash } from "./security";
import { AppError } from "./errors";
import type { Draft } from "../domain";

/** Private operator action. No public route invokes this installer. */
export async function installEditorial(manifestInputs: unknown[], comparisonInputs: unknown[], storage: Store = store(), warm = warmEditorial) {
  const manifests = manifestInputs.map((v) => liveSampleSchema.parse(v));
  const comparisons = comparisonInputs.map((v) => comparisonSchema.parse(v));
  if (manifests.length !== samples.length || samples.some((s) => manifests.filter((m) => m.sampleId === s.id).length !== 1) ||
      comparisons.length !== comparisonCases.length || comparisonCases.some((c) => comparisons.filter((r) => r.id === c.id && r.mode === "live").length !== 1))
    throw new AppError(400, "Install all three reviewed samples and five live comparisons together.");
  const writes: Write[] = [];
  async function add(key: string, value: unknown) { writes.push({ key, old: await storage.get(key), value: JSON.stringify(value), ttlMs: MONTH }); }
  for (const manifest of manifests) {
    const d: Draft = { id: "editorial", owner: "editorial-warmer", categories: ["movie", "book", "artist"], known: [], shared: [], excluded: [], revisions: [], version: 0, declaredBy: "sender", shareIds: [], updatedAt: new Date().toISOString(), expiresAt: Date.now() + MONTH, deleted: false, ...sampleDraft(manifest.sampleId, "editorial-warmer"), mode: "live" as const, shelf: manifest.shelf, tastes: manifest.tastes };
    await warm(d);
    await add(`live-sample:${manifest.sampleId}`, manifest);
  }
  for (const comparison of comparisons) {
    const version = comparison.version ?? hash(JSON.stringify(comparison));
    await add(`comparison:${comparison.id}:${version}`, { ...comparison, version });
    await add(`comparison-current:${comparison.id}`, version);
  }
  if (!(await storage.batchCas(writes))) throw new AppError(409, "Editorial records changed. Run the installation again.");
  return { samples: manifests.length, comparisons: comparisons.length, rankingTtlSeconds: 300 };
}
async function warmEditorial(draft: Draft) {
  // Exactly the namespace selected for a fresh visitor. No disk-cache substitution.
  const identities = JSON.stringify({ shelf: draft.shelf.map((e) => [e.entity.id, e.entity.kind]), tastes: draft.tastes.map((e) => [e.id, e.kind]) });
  const scope = `editorial:v1:${draft.sampleId}:${hash(identities)}`;
  const tools = new SelectionTools(draft, client(scope), AbortSignal.timeout(45000), async () => {}, async () => {});
  for (const kind of draft.categories) {
    const result = await tools.rank(kind, draft.version);
    if (!result.ref) throw new AppError(503, "A reviewed sample could not be warmed. Nothing was published.");
  }
}
