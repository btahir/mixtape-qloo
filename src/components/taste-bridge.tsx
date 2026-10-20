import type { Slot } from "@/lib/domain-view";
import { safeReading } from "@/lib/readings";
export function TasteBridge({ slot }: { slot: Slot }) {
  const reading = safeReading(slot);
  return reading ? <p className="taste-bridge">{reading}</p> : null;
}
