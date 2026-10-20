"use client";
import { useEffect, useRef, useState } from "react";
import { singular, type RunEvent, type Kind } from "@/lib/domain-view";
export function RunStatus({
  events,
  busy,
  onStop,
  startedAt,
  mode,
}: {
  events: RunEvent[];
  busy: boolean;
  onStop: () => void;
  startedAt: number;
  mode?: "live" | "fixture";
}) {
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (busy && document.activeElement === document.body) stop.current?.focus();
  }, [busy]);
  const [elapsedRun, setElapsedRun] = useState<number>();
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(
      () => setElapsedRun(startedAt),
      Math.max(0, 8000 - (Date.now() - startedAt)),
    );
    return () => clearTimeout(timer);
  }, [busy, startedAt]);
  const last = events.at(-1);
  const outstanding = new Set<Kind>();
  for (const event of events) {
    if (event.category && event.type === "tool_started")
      outstanding.add(event.category);
    if (
      event.category &&
      ["tool_completed", "needs_input"].includes(event.type)
    )
      outstanding.delete(event.category);
  }
  const waitingForQloo =
    mode === "live" &&
    (outstanding.size > 0 || last?.label === "Checking your favourites.");
  return (
    <section className="run-status" aria-label="Preparation status">
      {busy && (
        <>
          <h2>Choosing from your shelf</h2>
          <progress aria-label="Preparing your draft" />
          <button ref={stop} onClick={onStop}>Stop</button>
        </>
      )}
      <p role="status" aria-live="polite">
        {last?.label}
      </p>
      {last?.requested !== undefined && (
        <p>
          {last.completed} of {last.requested} choices checked
        </p>
      )}
      {busy && elapsedRun === startedAt && (
        <p>
          {waitingForQloo
            ? "Still waiting for Qloo. You can stop and keep your draft."
            : "Still preparing your draft. You can stop at any time."}
        </p>
      )}
      <details>
        <summary>See what happened</summary>
        <ol>
          {events.map((e) => (
            <li key={e.seq}>
              {e.label} {e.category && `· ${singular[e.category]}`} ·{" "}
              {new Date(e.at).toLocaleTimeString()}
              {e.audit && <p>{e.audit.eligible} eligible · {e.audit.returned} returned · {e.audit.missing} missing · {e.audit.rejected} excluded records. Attempt {e.audit.attempt} · {e.audit.elapsedMs} ms · {e.audit.cache === "illustrative" ? "Illustrative sample" : e.audit.cache === "hit" ? "Cached Qloo result" : "Fetched from Qloo"}{e.audit.fetchedAt && ` · ${new Date(e.audit.fetchedAt).toLocaleString()}`}</p>}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
