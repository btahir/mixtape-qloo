import "server-only";
import { z } from "zod";
import { entitySchema, entrySchema, type Draft } from "../domain";
import { read } from "./store";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hosted } from "./deployment";
import { inputFingerprint } from "../agent/tools";
import { hash } from "./security";
import { ensureQlooAccess } from "./limits";
/** Private access-spike output, never a public repository fixture. No public
 * route can install a manifest. Lookup alone dispatches no Qloo/model request. */
export const liveSampleSchema = z
  .object({
    sampleId: z.enum([
      "quiet-evenings",
      "a-little-more-soul",
      "stranger-worlds",
    ]),
    shelf: z.array(entrySchema).length(9),
    tastes: z.array(entitySchema).min(3).max(5),
    validatedAt: z.string(),
    coverageConfirmed: z.literal(true),
    repairConfirmed: z.literal(true),
    signalResponsivenessConfirmed: z.literal(true),
  })
  .strict()
  .refine(
    (v) =>
      [...v.shelf.map((e) => e.entity), ...v.tastes].every(
        (e) => e.mode === "live" && z.uuid().safeParse(e.id).success,
      ),
    "Live sample entities must be confirmed live UUIDs",
  );
export async function liveSample(
  id: string,
  owner: string,
): Promise<Pick<Draft, "shelf" | "tastes"> | null> {
  if (
    process.env.QLOO_MODE === "fixture" || !process.env.QLOO_API_KEY ||
    process.env.QLOO_EVENT_ACCESS_CONFIRMED !== "true"
  )
    return null;
  ensureQlooAccess();
  let manifest = await read(`live-sample:${id}`, liveSampleSchema);
  if (!manifest && !hosted() && ["quiet-evenings", "a-little-more-soul", "stranger-worlds"].includes(id)) {
    try { manifest = liveSampleSchema.parse(JSON.parse(await readFile(join(process.env.QLOO_SAMPLE_DIR || "live-samples", `${id}.json`), "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  if (!manifest) return null;
  return {
    shelf: manifest.shelf.map((e) => ({ ...e, confirmedBySession: owner })),
    tastes: manifest.tastes,
  };
}

/** Only exact, reviewed first-run identities share a cache. Private edits never do. */
export async function selectionCacheScope(d: Draft) {
  if (d.sampleId && d.mode === "live" && !d.revisions.length && !d.known.length && !d.shared.length && !d.excluded.length &&
    JSON.stringify(d.categories) === JSON.stringify(["movie", "book", "artist"])) {
    const reviewed = await liveSample(d.sampleId, "editorial-cache");
    const identities = (value: Pick<Draft, "shelf" | "tastes">) => JSON.stringify({
      shelf: value.shelf.map((e) => [e.entity.id, e.entity.kind]), tastes: value.tastes.map((e) => [e.id, e.kind]),
    });
    if (reviewed && identities(reviewed) === identities(d)) return `editorial:v1:${d.sampleId}:${hash(identities(reviewed))}`;
  }
  return `${d.owner}:${inputFingerprint(d)}`;
}
