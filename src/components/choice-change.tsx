import { current, singular, type Draft } from "@/lib/domain-view";

/** Compare persisted outcomes only. This is a change receipt, not a causal claim. */
export function ChoiceChange({ draft }: { draft: Draft }) {
  const result = current(draft);
  if (!result || result.replacementKind) return null;
  const signals = result.slots[0]?.evidence.signals ?? [];
  const key = signals.map((signal) => signal.id).sort().join(",");
  const previous = draft.revisions.slice(0, -1).findLast((revision) =>
    revision.slots[0]?.evidence.signals.map((signal) => signal.id).sort().join(",") !== key,
  );
  if (!previous) return null;
  const oldSignals = previous.slots[0].evidence.signals;
  const added = signals.filter((signal) => !oldSignals.some((old) => old.id === signal.id));
  const removed = oldSignals.filter((signal) => !signals.some((now) => now.id === signal.id));
  return <section className="choice-change" aria-label="What changed with these tastes">
    <p className="eyebrow">Different tastes, a different edition</p>
    <h2>{removed.map((signal) => signal.name).join(" + ") || "Earlier tastes"}<span aria-label="changed to"> → </span>{added.map((signal) => signal.name).join(" + ") || "Updated tastes"}</h2>
    <ul>{result.slots.map((slot) => {
      const old = previous.slots.find((before) => before.kind === slot.kind);
      return <li key={slot.kind}><span>{singular[slot.kind]}</span><strong>{old?.entity.id === slot.entity.id ? `${slot.entity.name} stayed` : `${old?.entity.name ?? "No choice"} → ${slot.entity.name}`}</strong></li>;
    })}</ul>
    <p>Two saved results from your edits. Different choices do not prove better choices.</p>
  </section>;
}
