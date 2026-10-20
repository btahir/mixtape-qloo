import "server-only";
import { readComparison } from "./comparison";
import type { TasteExample } from "@/components/taste-example";

export async function tasteExample(): Promise<TasteExample | undefined> {
  const [before, after] = await Promise.all([readComparison("quiet-evenings"), readComparison("quiet-evenings-other-tastes")]);
  if (!before || !after || before.mode !== "live" || after.mode !== "live" || before.withQloo.failure || after.withQloo.failure) return;
  const fixed = (record: typeof before) => JSON.stringify([record.shelfIds, record.excludedIds.filter((id) => !record.signalIds.includes(id)), record.locks, record.categories, record.model, record.configHash]);
  const removed = before.signalIds.filter((id) => !after.signalIds.includes(id));
  const added = after.signalIds.filter((id) => !before.signalIds.includes(id));
  if (fixed(before) !== fixed(after) || removed.length !== 1 || added.length !== 1) return;
  const name = (id: string) => [...before.catalog, ...after.catalog].find((entity) => entity.id === id)?.name;
  const from = name(removed[0]), to = name(added[0]);
  const choices = before.categories.flatMap((kind) => {
    const a = before.withQloo.choices.find((choice) => choice.kind === kind);
    const b = after.withQloo.choices.find((choice) => choice.kind === kind);
    const first = a && name(a.entityId), second = b && name(b.entityId);
    return first && second ? [{ kind, from: first, to: second, changed: a!.entityId !== b!.entityId }] : [];
  });
  if (!from || !to || choices.length !== before.categories.length) return;
  return { from, to, choices, date: before.createdAt };
}
