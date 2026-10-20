"use client";
import { readingFact, supportedDetail } from "@/lib/readings";
import { TasteBridge } from "./taste-bridge";
import Link from "next/link";
import { api } from "@/lib/client";
import { useState } from "react";
import { singular, entityDetail, type Slot } from "@/lib/domain-view";
import { Sheet } from "./ui/sheet";
export function EvidenceView({ slot, sender, recipient = false }: { slot: Slot; sender: string; recipient?: boolean }) {
  const [open, setOpen] = useState(false);
  const [comparison, setComparison] = useState<string>();
  const e = slot.evidence, sample = e.mode === "fixture", earlier = slot.previousTastes || slot.previousShelf;
  return <>
    <button className="action-evidence" onClick={() => { setOpen(true); void api<{ href?: string }>("/api/comparisons", "GET").then((value) => setComparison(value.href)).catch(() => {}); }}>Why this?</button>
    <Sheet title={slot.entity.name} open={open} onOpenChange={setOpen}>
      <p className="eyebrow">Why this pick</p>
      <TasteBridge slot={slot} />
      {supportedDetail(slot.entity, e.readingDetail) && <p className="reading-source">The connection is reported by Qloo. The description is separately sourced; it does not explain why the connection exists. <a href={readingFact(slot.entity)!.source} target="_blank" rel="noopener noreferrer">Description source ↗</a></p>}
      {sample ? <><p className="source-label">Illustrative sample</p><p>These choices are illustrative. They are not Qloo recommendations.</p></> : <>
        {earlier ? <p>{slot.locked && "This piece was kept by the sender. "}This result used {slot.previousShelf && slot.previousTastes ? "an earlier shelf and different tastes" : slot.previousShelf ? "an earlier shelf" : "different tastes"}. Update the choices to check the current inputs.</p>
          : <p className="evidence-lead">Qloo ranked this {e.rank === 1 ? "1st" : e.rank === 2 ? "2nd" : e.rank === 3 ? "3rd" : `${e.rank}th`} among {e.returnedCount} returned {singular[slot.kind]}{e.returnedCount === 1 ? "" : "s"} from {e.eligibleCount} eligible favourites.</p>}
        <p className="evidence-limit">A cultural connection, not a prediction of enjoyment.</p>
        <p className="evidence-freshness">{earlier ? "Earlier Qloo result · Retrieved" : e.cache === "hit" ? "Qloo result · Cached from" : "Qloo result · Retrieved"} {e.fetchedAt ? new Date(e.fetchedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "time unavailable"}</p>
        {earlier && <p>This has not been refreshed.</p>}
        {e.warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </>}
      {slot.note && <><h3>{recipient ? `${sender || "Your friend"}'s words` : "Your words"}</h3><p className="human-note">{slot.note}</p></>}
      <details className="evidence-request">
        <summary>Details</summary>
        <h3>Reported connections</h3>
        {e.explanationStatus === "verified" && !earlier ? <>
          <p>For this {singular[slot.kind]}, Qloo reported connections to {e.contributions?.flatMap((c) => { const signal = e.signals.find((s) => s.id.toUpperCase() === c.entityId.toUpperCase()); return signal ? [`${signal.name} (${singular[signal.kind]})`] : []; }).join(", ")}.</p>
          <p>These are cultural connections, not a prediction of enjoyment.</p>
        </> : <p>{earlier ? "Individual connections belong to the earlier result." : e.explanationStatus === "failed" ? "Qloo could not provide individual connections for this result." : e.explanationStatus === "unverified" ? "Qloo returned explanation data that Mixtape cannot display yet." : "Qloo did not return individual connections for this result."}</p>}

        {e.highlightedSignalId && !earlier && <p>The agent highlighted a connection from Qloo’s reported evidence.</p>}
        <h3>Their tastes</h3>
        <ul>{e.signals.map((s) => <li key={s.id}>{s.name} · {singular[s.kind]}{entityDetail(s) ? ` · ${entityDetail(s)}` : ""}</li>)}</ul>
        <h3>{recipient ? `From ${sender || "your friend"}'s favourites` : "From your shelf"}</h3>
        <p>{e.eligibleCount} eligible · {e.returnedCount} returned · {e.missingCount} missing · {e.rejectedCount} unsupported records excluded.</p>
        {e.missingCount > 0 && <p>{e.missingCount} favourites were not returned. Their fit is unknown.</p>}
        {!sample && <>
          {e.explanationStatus === "verified" && !earlier && <><h3>Contribution values</h3><ul className="contribution-list">{e.contributions?.map((c) => <li key={c.entityId}><span>{e.signals.find((s) => s.id.toUpperCase() === c.entityId.toUpperCase())?.name}</span><span>{c.score.toFixed(3)}</span></li>)}</ul><p>Values apply only to this query. An omitted taste has no reported contribution here.</p></>}
          <h3>Qloo evidence</h3>
          <p>GET /v2/insights · {e.category} · live</p>
          <p>Retrieved: {e.fetchedAt ? new Date(e.fetchedAt).toLocaleString() : "Time unavailable"}</p>
          <p>Selected UUID: {e.selectedId}</p>
          <p>Signal UUIDs: {e.signals.map((s) => s.id).join(", ")}</p>
          {!earlier && e.score !== null && <><p>Affinity in this query: {e.score.toFixed(3)}</p><p>Unrounded affinity: {e.score}</p><p>Affinity describes a cultural connection. It is not a prediction of what one person will like.</p></>}
        </>}
      </details>
      {comparison && <p><Link prefetch={false} onClick={() => setOpen(false)} href="/connections">See what one different taste changed</Link><small className="comparison-link-note">This example uses its own shelf and tastes.</small></p>}
    </Sheet>
  </>;
}
