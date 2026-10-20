import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { readComparison, type Comparison } from "@/lib/server/comparison";
import { singular } from "@/lib/domain-view";

function controlledPair(a: Comparison, b: Comparison) {
  const constraints = (record: Comparison) => JSON.stringify([record.shelfIds, record.excludedIds.filter((id) => !record.signalIds.includes(id)), record.locks, record.categories, record.model, record.configHash]);
  return a.mode === "live" && b.mode === "live" && !a.withQloo.failure && !b.withQloo.failure && constraints(a) === constraints(b)
    && a.signalIds.filter((id) => !b.signalIds.includes(id)).length === 1 && b.signalIds.filter((id) => !a.signalIds.includes(id)).length === 1;
}
async function ConnectionStory() {
  await connection();
  const [before, after] = await Promise.all([readComparison("quiet-evenings"), readComparison("quiet-evenings-other-tastes")]);
  if (!before || !after || !controlledPair(before, after)) return <><h1>This connection is not available yet.</h1><Link href="/">Make a mixtape</Link></>;
  const name = (record: Comparison, id: string) => record.catalog.find((entity) => entity.id === id)?.name ?? "Identity unavailable";
  const removed = before.signalIds.find((id) => !after.signalIds.includes(id))!;
  const added = after.signalIds.find((id) => !before.signalIds.includes(id))!;
  const changed = before.categories.filter((kind) => before.withQloo.choices.find((choice) => choice.kind === kind)?.entityId !== after.withQloo.choices.find((choice) => choice.kind === kind)?.entityId);
  const stayed = before.categories.filter((kind) => !changed.includes(kind));
  return <article className="connection-story">
    <p className="eyebrow">A small change. Across three worlds.</p>
    <h1>Change the book.<br /><em>See what follows.</em></h1>
    <p className="connection-intro">Maya’s nine favourites stayed the same. So did {before.signalIds.filter((id) => after.signalIds.includes(id)).map((id) => name(before, id)).join(" and ")}. Only one of Leo’s tastes changed.</p>
    <div className="taste-swap"><span>{name(before, removed)}</span><span aria-label="changed to">→</span><strong>{name(after, added)}</strong></div>
    <div className="connection-outcomes">{before.categories.map((kind) => {
      const first = before.withQloo.choices.find((choice) => choice.kind === kind);
      const second = after.withQloo.choices.find((choice) => choice.kind === kind);
      const same = first?.entityId === second?.entityId;
      return <section key={kind} data-changed={!same}>
        <p className="eyebrow">{singular[kind]} · {same ? "Stayed" : "Changed"}</p>
        {!same && first && <p className="earlier-pick">{name(before, first.entityId)}</p>}
        <h2>{second ? name(after, second.entityId) : "No choice"}</h2>
      </section>;
    })}</div>
    <p className="connection-caption">{changed.length ? `The ${changed.map((kind) => singular[kind]).join(" and ")} changed.` : "All three choices stayed."}{stayed.length > 0 && changed.length > 0 ? ` The ${stayed.map((kind) => singular[kind]).join(" and ")} stayed.` : ""}</p>
    <p className="fine-print">Two saved live Qloo rankings of a fictional exchange, saved {new Date(before.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}. Same shelf, constraints and selection policy. No model ran in these saved comparisons. Different choices do not prove better choices.</p>
    <div className="story-actions"><Link className="primary" href="/">Try your own combination</Link><Link href="/compare/quiet-evenings">Original tastes: evidence</Link><Link href="/compare/quiet-evenings-other-tastes">Changed tastes: evidence</Link></div>
  </article>;
}
export default function Connections() {
  return <Suspense fallback={<p>Opening the connection…</p>}><ConnectionStory /></Suspense>;
}
