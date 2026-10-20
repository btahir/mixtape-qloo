import type { Draft } from "../domain";
import { eligibility } from "../domain";
/** Identical catalog-only context for both evaluation arms. No personal names,
 * human notes, affinity, ranking, result refs or contributions. */
export function catalogContext(d: Draft) {
  const entity = (e: Draft["tastes"][number]) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    detail: e.detail,
    ...(e.description ? { description: e.description.slice(0, 120) } : {}),
  });
  return {
    shelf: d.shelf.map((e) => entity(e.entity)),
    signals: d.tastes.map(entity),
    categories: d.categories,
    excluded: [
      ...new Set([
        ...d.known,
        ...d.shared,
        ...d.excluded,
        ...d.tastes.map((e) => e.id),
      ]),
    ],
    locks:
      d.revisions
        .at(-1)
        ?.slots.filter((s) => s.locked)
        .map((s) => ({ kind: s.kind, entityId: s.entity.id })) ?? [],
    allowed: d.categories.flatMap((kind) =>
      eligibility(d, kind).map((e) => ({ kind, entityId: e.entity.id })),
    ),
  };
}
