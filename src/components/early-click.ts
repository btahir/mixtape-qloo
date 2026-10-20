"use client";
import { useEffect, useRef } from "react";

/**
 * Clicks that land before hydration are queued by a tiny inline script in the root
 * layout (see EARLY_CLICK_SCRIPT) and replayed here once the handler exists, so a
 * cold first click is never swallowed.
 */
export const EARLY_CLICK_SCRIPT = `(function(){var q=window.__mixtapeEarly=[];document.addEventListener("click",function(e){var t=e.target,b=t&&t.closest&&t.closest("[data-early]");if(!b||b.hasAttribute("data-live")||b.disabled)return;e.preventDefault();var k=b.getAttribute("data-early");if(q.indexOf(k)<0)q.push(k);document.documentElement.style.cursor="progress"},true)})()`;
type EarlyWindow = Window & { __mixtapeEarly?: string[] };
export function useEarlyClick<T extends HTMLElement>(key: string, run: () => void) {
  const ref = useRef<T>(null);
  const latest = useRef(run);
  useEffect(() => { latest.current = run; });
  useEffect(() => {
    ref.current?.setAttribute("data-live", "");
    const queue = (window as EarlyWindow).__mixtapeEarly;
    const index = queue?.indexOf(key) ?? -1;
    if (index < 0) return;
    queue!.splice(index, 1);
    if (!queue!.length) document.documentElement.style.removeProperty("cursor");
    latest.current();
  }, [key]);
  return ref;
}
