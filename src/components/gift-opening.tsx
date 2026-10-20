"use client";
import { useState } from "react";
import type { Kind } from "@/lib/domain-view";
import { Parcel } from "./print";
import { useEarlyClick } from "./early-click";

/** Keep the physical sleeve in place until its front has opened. */
export function GiftOpening({ sender, recipient, categories, disabled, onOpen, onReveal }: {
  sender: string; recipient: string; categories: Kind[]; disabled?: boolean;
  onOpen?: () => Promise<void>; onReveal: () => void;
}) {
  const [phase, setPhase] = useState<"closed" | "waiting" | "opening">("closed");
  const start = async () => {
    if (phase !== "closed") return;
    setPhase("waiting");
    try {
      await onOpen?.();
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onReveal();
      else setPhase("opening");
    } catch { setPhase("closed"); }
  };
  const button = useEarlyClick<HTMLButtonElement>("open-gift", () => void start());
  return <div className={`unopened-gift ${phase === "opening" ? "sleeve-opening" : ""}`}>
    <div className="sleeve-anchor" onAnimationEnd={(event) => {
      if (event.animationName === "open-sleeve") onReveal();
    }}><Parcel sender={sender || "Your"} recipient={recipient || "You"} categories={categories} /></div>
    <button ref={button} data-early="open-gift" className="primary" disabled={disabled || phase !== "closed"} onClick={() => void start()}>{phase === "waiting" ? "Opening…" : "Open your mixtape"}</button>
    <p>{categories.length === 3 ? "Three" : "Two"} favourites from their world, chosen for yours.</p>
  </div>;
}
