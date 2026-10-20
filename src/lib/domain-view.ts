import type { Draft, Entity, Kind, Revision } from "./domain";
export type { Draft, Entity, Kind, Revision, Slot, Run, RunEvent, Gift } from "./domain";
export const kinds = ["movie", "book", "artist"] as const;
export const labels: Record<Kind, string> = {
  movie: "A film",
  book: "A book",
  artist: "An artist",
};
export const singular: Record<Kind, string> = {
  movie: "film",
  book: "book",
  artist: "artist",
};
export function entityDetail(entity: Entity) {
  return entity.detail === entity.name || entity.detail === "Fictional sample identity" ? "" : entity.detail;
}
export function current(d: { revisions: Revision[] }) {
  return d.revisions.at(-1);
}
export function replacementIndex(revisions: Revision[]) {
  return revisions.findLastIndex((r, i) => i > 0 && !!r.replacementKind);
}
export function eligibility(
  d: Pick<Draft, "shelf" | "tastes" | "known" | "shared" | "excluded">,
  kind: Kind,
  extra: string[] = [],
) {
  const excluded = new Set([
    ...d.tastes.map((e) => e.id),
    ...d.known,
    ...d.shared,
    ...d.excluded,
    ...extra,
  ]);
  return d.shelf.filter(
    (e) => e.entity.kind === kind && !excluded.has(e.entity.id),
  );
}

/** Exact ranking inputs; human wording and save versions cannot enable an empty retry. */
export function selectionRequestKey(d: Draft, kind: Kind, repair = false) {
  const selected = current(d)?.slots ?? [];
  const excluded = [...new Set([...d.known, ...d.shared, ...d.excluded,
    ...d.tastes.map((e) => e.id), ...selected.filter((s) => repair || s.kind !== kind).map((s) => s.entity.id)])].sort();
  return JSON.stringify({ kind, mode: d.mode, tastes: d.tastes.map((e) => e.id),
    candidates: d.shelf.filter((e) => e.entity.kind === kind && !excluded.includes(e.entity.id)).map((e) => e.entity.id), excluded });
}
export function selectionBlocked(d: Draft, kind: Kind, repair = false) {
  return d.blockedSelections?.some((b) => b.kind === kind && b.fingerprint === selectionRequestKey(d, kind, repair)) ?? false;
}
