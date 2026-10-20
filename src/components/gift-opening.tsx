"use client";
import { useState } from "react";
import type { Kind } from "@/lib/domain-view";
import { Parcel } from "./print";

/** Keep the physical sleeve in place until its front has opened. */
export function GiftOpening({ sender, recipient, categories, disabled, onOpen, onReveal }: {
  sender: string; recipient: string; categories: Kind[]; disabled?: boolean;
  onOpen?: () => Promise<void>; onReveal: () => void;
}) {
  const [phase, setPhase] = useState<"closed" | "waiting" | "opening">("closed");
  return <div className={`unopened-gift ${phase === "opening" ? "sleeve-opening" : ""}`}>
    <div className="sleeve-anchor" onAnimationEnd={(event) => {
      if (event.animationName === "open-sleeve") onReveal();
    }}><Parcel sender={sender || "Your"} recipient={recipient || "You"} categories={categories} /></div>
    <button className="primary" disabled={disabled || phase !== "closed"} onClick={async () => {
      setPhase("waiting");
      try {
        await onOpen?.();
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onReveal();
        else setPhase("opening");
      } catch { setPhase("closed"); }
    }}>{phase === "waiting" ? "Opening…" : "Open your mixtape"}</button>
    <p>{categories.length === 3 ? "Three" : "Two"} favourites from their world, chosen for yours.</p>
  </div>;
}
