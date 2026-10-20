import { test, expect } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { entitySchema as wireEntity } from "../src/lib/qloo/schemas";
import { projectEntity, client } from "../src/lib/server/qloo";
import { demoContentAllowed, invalidRequiredSignal } from "../src/lib/qloo/normalize";
import { samples, sampleDraft } from "../src/lib/samples";
import { liveSampleSchema, selectionCacheScope } from "../src/lib/server/sample-manifest";
import { createDraft } from "../src/lib/server/repository";
import { SelectionTools } from "../src/lib/agent/tools";
import { runSelection } from "../src/lib/agent";
import { freezeEvaluationInput, evaluateCase } from "../src/lib/server/comparison";
import { current, type Draft, type Kind } from "../src/lib/domain";

/** Explicit private preparation only. Input is an editorial identity audit, never credentials. */
test.skipIf(process.env.MIXTAPE_PREPARE_LIVE !== "true")("validate and warm reviewed live samples and five frozen comparisons", async () => {
  try { process.loadEnvFile(".env.local"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!process.env.QLOO_REVIEWED_INPUT || !process.env.QLOO_DEV_CACHE_DIR || !process.env.QLOO_API_KEY) throw new Error("Set the reviewed input and private cache directories.");
  const directory = process.env.QLOO_SAMPLE_DIR || "live-samples";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const audit = JSON.parse(await readFile(join(process.env.QLOO_REVIEWED_INPUT, "audit-state.json"), "utf8"));
  const normalize = (s: string) => s.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const evidence: unknown[] = [], drafts: Draft[] = [];
  async function resolve(name: string, kind: Kind) {
    let raw = audit.selections[`${kind}:${normalize(name.split(" — ")[0])}`];
    if (name.startsWith("The Left Hand of Darkness")) {
      // Reviewed duplicate that also works as a return-gift taste, not just a candidate.
      const response = JSON.parse(await readFile(join(process.env.QLOO_REVIEWED_INPUT!, "call-028.json"), "utf8"));
      raw = response.results[1];
    }
    const checked = wireEntity.parse(raw);
    if (!demoContentAllowed(checked)) throw new Error(`Editorial content review needed: ${name}`);
    const entity = projectEntity(checked, "live", "2026-10-19T00:00:00.000Z");
    if (!entity || entity.kind !== kind) throw new Error(`Unresolved editorial identity: ${name}`);
    // Sample notes carry the voice; unreviewed catalog prose stays out of these cards.
    delete entity.description;
    return entity;
  }
  async function select(draft: Draft, repair?: Kind) {
    const t = new SelectionTools(draft, client(await selectionCacheScope(draft)), AbortSignal.timeout(45000), async () => {}, async () => {}, repair);
    const result = await runSelection(t);
    expect(result.status).toBe("ready");
    expect(result.slots.every((s) => s.evidence.score !== null && s.method === "qloo")).toBe(true);
    return result.slots;
  }
  for (const sample of samples) {
    const d = await createDraft(`editorial:${sample.id}`, "fixture", sample.id);
    const original = sampleDraft(sample.id, d.owner);
    d.mode = "live";
    d.shelf = await Promise.all(original.shelf.map(async (entry, i) => ({ ...entry, entity: await resolve(sample.shelf.flat()[i], entry.entity.kind) })));
    d.tastes = await Promise.all(original.tastes.map((entity, i) => resolve(sample.tastes[i], entity.kind)));
    const hydrated = await client("editorial-hydration").getEntities({ entity_ids: [...d.shelf.map((s) => s.entity.id), ...d.tastes.map((e) => e.id)] });
    const checked = new Map(hydrated.data.results.map((raw) => {
      if (!demoContentAllowed(raw)) throw new Error(`Editorial content review needed: ${raw.name}`);
      const entity = projectEntity(raw, "live", hydrated.provenance.fetchedAt);
      if (!entity) throw new Error("Unusable hydrated identity.");
      delete entity.description;
      return [entity.id, entity] as const;
    }));
    for (const entry of d.shelf) { const entity = checked.get(entry.entity.id); expect(entity?.kind).toBe(entry.entity.kind); entry.entity = entity!; }
    d.tastes = d.tastes.map((e) => { const entity = checked.get(e.id); expect(entity?.kind).toBe(e.kind); return entity!; });
    const slots = await select(d);
    d.revisions = [{ id: "editorial-revision", fingerprint: slots[0].evidence.fingerprint, slots, excluded: [], createdAt: new Date().toISOString() }];
    const book = slots.find((s) => s.kind === "book")!;
    const repair = structuredClone(d); repair.excluded.push(book.entity.id);
    const repaired = await select(repair, "book");
    expect(repaired.find((s) => s.kind === "book")?.entity.id).not.toBe(book.entity.id);
    expect(repaired.filter((s) => s.kind !== "book")).toEqual(slots.filter((s) => s.kind !== "book"));
    // Each selected identity must be usable as a signal when the relationship reverses.
    const reverse = await client("return-seed-check").insights({ "filter.type": "urn:entity:movie", "signal.interests.entities": slots.map((s) => s.entity.id), take: 1, "feature.explainability": true });
    expect(invalidRequiredSignal(reverse.data.warnings, slots.map((s) => s.entity.id))).toBe(false);
    expect(reverse.data.results.entities.some((e) => e.query?.affinity !== undefined)).toBe(true);
    const changed = structuredClone(d);
    changed.revisions = [];
    changed.tastes = sample.id === "quiet-evenings"
      ? [d.tastes[0], await resolve("Piranesi", "book"), d.tastes[2]]
      : sample.id === "a-little-more-soul" ? [await resolve("Arrival", "movie"), await resolve("Good Omens", "book"), await resolve("Radiohead", "artist")]
      : [await resolve("Spirited Away", "movie"), await resolve("The Little Prince", "book"), await resolve("Bon Iver", "artist")];
    const alternative = await select(changed);
    expect(alternative.map((s) => s.entity.id)).not.toEqual(slots.map((s) => s.entity.id));
    const manifest = liveSampleSchema.parse({ sampleId: sample.id, shelf: d.shelf, tastes: d.tastes, validatedAt: new Date().toISOString(), coverageConfirmed: true, repairConfirmed: true, signalResponsivenessConfirmed: true });
    await writeFile(join(directory, `${sample.id}.json`), JSON.stringify(manifest), { mode: 0o600 });
    evidence.push({ sample: sample.id, choices: slots.map((s) => ({ name: s.entity.name, evidence: s.evidence })), replacement: repaired.find((s) => s.kind === "book")?.entity.name, changedChoices: alternative.map((s) => s.entity.name), returnSignalsValid: true });
    d.revisions = [];
    await select(d); // Warm the local disk cache only; production Redis requires separate verification.
    drafts.push(d);
  }
  const changed = structuredClone(drafts[0]); changed.tastes[1] = await resolve("Piranesi", "book");
  const low = structuredClone(drafts[0]); low.known = low.shelf.filter((e) => e.entity.kind === "book").map((e) => e.entity.id);
  const cases = [...drafts.map((d) => ({ id: d.sampleId!, draft: d })), { id: "quiet-evenings-other-tastes", draft: changed }, { id: "known-low-coverage", draft: low }];
  // These are curated demonstrations: curation above already observed selections.
  // Freezing prevents later input changes; it does not make them unseen evaluation cases.
  for (const c of cases) await freezeEvaluationInput(c.id, c.draft);
  for (const c of cases) {
    const result = await evaluateCase(c.id, c.draft, `evaluation:${c.id}`, `evaluation:${c.id}`);
    await writeFile(join(directory, `comparison-${c.id}.json`), JSON.stringify(result), { mode: 0o600 });
  }
  await writeFile(join(directory, "validation.json"), JSON.stringify({ validatedAt: new Date().toISOString(), samples: evidence, comparisonCases: cases.map((c) => c.id), primary: current(drafts[0]) }), { mode: 0o600 });
  console.log("Three live samples validated; five comparisons retained. See the private cache ledger for actual dispatch count.");
});
