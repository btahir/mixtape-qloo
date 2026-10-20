"use client";
import type { ReactNode } from "react";
import { entityDetail, labels, type Slot } from "@/lib/domain-view";
import { EntityArt } from "./entity-art";
import { TasteBridge } from "./taste-bridge";
import { firstStep } from "@/lib/first-step";
import { EvidenceView } from "./evidence";
export function GiftPanels({
  slots,
  sender,
  recipient = false,
  actions,
  noteEditor,
  ordinals,
}: {
  slots: Slot[];
  sender: string;
  recipient?: boolean;
  actions?: (slot: Slot) => ReactNode;
  noteEditor?: (slot: Slot) => ReactNode;
  ordinals?: Partial<Record<Slot["kind"], number>>;
}) {
  return (
    <ol className="panels" data-count={slots.length}>
      {slots.map((s, index) => (
        <li key={s.kind} data-kind={s.kind} id={`piece-${s.kind}`}>
          <article key={s.entity.id} tabIndex={-1} aria-label={s.entity.name}>
            <EntityArt
              key={`${s.entity.id}:${s.entity.imageUrl}`}
              entity={s.entity}
              index={ordinals?.[s.kind] ?? index}
            />
            <div className="insert-info">
              <p className="piece-category">{labels[s.kind]}</p>
              {s.evidence.mode === "fixture" && (
                <p className="source-label">Illustrative sample</p>
              )}
              {recipient && s.note && (
                <p className="human-note">
                  {s.note}
                </p>
              )}
              <h2 className="piece-title">{s.entity.name}</h2>
              {<p className="metadata" aria-hidden={!entityDetail(s.entity) || undefined}>{entityDetail(s.entity) || "\u00a0"}</p>}
              {recipient && !s.note && <p>One of {sender || "your friend"}&apos;s favourites.</p>}
              {!recipient && (
                <p className="human-note">
                  {s.note || "Add a few words of your own."}
                </p>
              )}
              <TasteBridge slot={s} />
              {s.method === "human_lock" && <p>{recipient ? `Kept by ${sender || "the sender"}` : "Kept by you"}</p>}
              <a className="explore-piece" href={firstStep(s.entity).href} target="_blank" rel="noopener noreferrer"><span><small>{firstStep(s.entity).caption}</small>{firstStep(s.entity).label}</span><span aria-hidden="true">↗</span></a>
              <div className="piece-utilities"><EvidenceView slot={s} sender={sender} recipient={recipient} />
              <details className="piece-menu"><summary>{recipient ? "Options" : "Notes / change"}<span aria-hidden="true">＋</span></summary>
                <div className="panel-actions">
                  {actions?.(s)}
                {noteEditor?.(s)}
              {(s.entity.description || (!recipient && s.entity.destination)) && <details className="entity-description"><summary>About this {s.kind === "movie" ? "film" : s.kind}</summary>{s.entity.description && <p>{s.entity.description}</p>}{!recipient && s.entity.destination && <a className="action-details" href={s.entity.destination} target="_blank" rel="noopener noreferrer">{s.entity.destination.startsWith("https://open.spotify.com/") ? "Open on Spotify" : s.entity.destination.startsWith("https://www.imdb.com/") ? "Read on IMDb" : s.entity.destination.startsWith("https://www.goodreads.com/") ? "Read on Goodreads" : "Open details"} ↗</a>}</details>}
                </div>
              </details></div>
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}
