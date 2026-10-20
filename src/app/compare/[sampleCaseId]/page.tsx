import { headers } from "next/headers";
import { rate } from "@/lib/server/limits";
import { ipKey } from "@/lib/server/security";
import { AppError } from "@/lib/server/errors";
import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { comparisonCases } from "@/lib/samples";
import { withRequestDeadline } from "@/lib/server/store";
import { readComparison } from "@/lib/server/comparison";
import { notFound } from "next/navigation";
import { EvidenceView } from "@/components/evidence";
import { singular } from "@/lib/domain";
import type { Metadata } from "next";
export async function generateMetadata({ params }: { params: Promise<{ sampleCaseId: string }> }): Promise<Metadata> {
  await connection();
  const { sampleCaseId } = await params;
  const c = comparisonCases.find((c) => c.id === sampleCaseId);
  if (!c) return { title: "Comparison not found" };
  return {
    title: `${c.title}: what Qloo changed`,
    description: "The same shelf, tastes and constraints, ranked with and without Qloo, with the evidence for each choice.",
    alternates: { canonical: `/compare/${c.id}` },
  };
}
async function Content({
  params,
}: {
  params: Promise<{ sampleCaseId: string }>;
}) {
  await connection();
  const { sampleCaseId } = await params;
  const c = comparisonCases.find((c) => c.id === sampleCaseId);
  if (!c) notFound();
  let r;
  try {
    const h = await headers();
    r = await withRequestDeadline(5000, async () => {
      await rate("read", "", ipKey(new Request("http://local", { headers: h })));
      return readComparison(sampleCaseId);
    });
  } catch (error) {
    return <><h1>We cannot open this comparison right now.</h1><p>{error instanceof AppError && error.status === 429 ? "A few pages were opened quickly. Please try again shortly." : "Please try again."}</p><a href={`/compare/${sampleCaseId}`}>Try again</a></>;
  }
  const baseline = r?.method === "deterministic-ablation" ? "Original shelf order" : "Without Qloo";
  return (
    <>
      <h1>What changed with Qloo?</h1>
      <p>Same shelf. Same tastes. Same constraints.</p>
      <h2>{c.title}</h2>
      {r?.method === "deterministic-ablation" && <p className="notice">Live Qloo ranking versus the sender’s original shelf order. Both use the local selection policy; no language model ran. This shows what ranking changes, not which gift someone prefers.</p>}
      {r?.method === "policy-comparison" && <p className="notice">Two selection policies using the same shelf and tastes. The Qloo agent receives ranking tools; the catalog-only model receives a different context and policy. This is not a matched model comparison.</p>}
      <nav className="comparison-nav" aria-label="Comparison sections">
        <a href="#choices">Choices</a>
        <a href="#evidence">Evidence</a>
        <a href="#all-cases">All cases</a>
      </nav>
      <section id="choices" className="comparison-choices">
        <h2>Choices</h2>
        {!r ? <p>This comparison has not been run yet.</p> : <>
          {(["withQloo", "withoutQloo"] as const).map((key) => r[key].failure && <p key={key}>{key === "withQloo" ? "With Qloo" : baseline}: {r[key].failure}</p>)}
          {r.categories.map((kind) => {
            const ranked = r.withQloo.choices.find((v) => v.kind === kind);
            const original = r.withoutQloo.choices.find((v) => v.kind === kind);
            return <div className="comparison-pair" key={kind}>
              <header><h3>{singular[kind]}</h3><p>{ranked && original ? ranked.entityId === original.entityId ? "Same choice" : "Changed" : "Selection incomplete"}</p></header>
              <div className="columns">{(["withQloo", "withoutQloo"] as const).map((key) => {
                const selected = r[key].choices.find((v) => v.kind === kind);
                return <div key={key}><p className="eyebrow">{key === "withQloo" ? "With Qloo" : baseline}</p><strong>{selected ? r.catalog.find((e) => e.id === selected.entityId)?.name ?? "Identity unavailable" : "No selection"}</strong></div>;
              })}</div>
            </div>;
          })}
        </>}
      </section>
      <section id="evidence">
        <h2>Evidence</h2>
        {r ? (
          <>
            {r.withQloo.evidence.map((slot) => <div key={slot.kind}><h3>{slot.entity.name}</h3><EvidenceView slot={slot} sender="the sample sender" /></div>)}
            <details className="comparison-technical"><summary>Technical details</summary><p>
              Source: {r.mode} · Model: {r.model} · Run: {r.createdAt}
            </p>
            <p>
              Metadata: {r.metadataHash} · Configuration: {r.configHash}
            </p>
            {r.config && <dl className="comparison-config">{Object.entries(r.config).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
            {(["withQloo", "withoutQloo"] as const).map((arm) => <div key={arm}><h3>{arm === "withQloo" ? "With Qloo" : baseline}</h3><ul>{r[arm].choices.map((choice) => <li key={choice.kind}>{choice.kind}: {choice.entityId}</li>)}</ul>
              <p>{r[arm].latencyMs} ms · Reserved ${r[arm].reservedUsd.toFixed(2)} · {r[arm].createdAt}</p>
              {r[arm].audit && <><h4>Model usage</h4><ol>{r[arm].audit.steps.map((step, index) => <li key={index}>Step {index + 1}: {step.inputTokens ?? "Unknown"} input tokens · {step.outputTokens ?? "Unknown"} output tokens · input bound {r[arm].audit?.inputBounds[index] ?? "Unknown"}</li>)}</ol></>}
            </div>)}
            <p>
              Signals:{" "}
              {r.signalIds
                .map((id) => r.catalog.find((e) => e.id === id)?.name ?? id)
                .join(", ")}
            </p>
            <p>Exclusions: {r.excludedIds.join(", ") || "None"}</p>
            <p>Locks: {r.locks.map((x) => x.entityId).join(", ") || "None"}</p>
            </details>
            <p>
              {r.method === "deterministic-ablation" ? "No model charges. Recipient preference has not been measured." : "Actual billing and recipient preference have not been measured."}
            </p>
          </>
        ) : (
          <p>
            No measured model, date, selection, cost or preference result is
            available.
          </p>
        )}
        <p>Different choices do not prove better choices.</p>
      </section>
      <section id="all-cases">
        <h2>All cases</h2>
        <ul>
          {comparisonCases.map((c) => (
            <li key={c.id}>
              <Link prefetch={false} href={`/compare/${c.id}`}>
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
export default function Compare(props: {
  params: Promise<{ sampleCaseId: string }>;
}) {
  return (
    <Suspense fallback={<p>Opening comparison…</p>}>
      <Content {...props} />
    </Suspense>
  );
}
