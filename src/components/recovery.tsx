"use client";
import { CooldownMessage, useCooldown } from "./use-cooldown";
import Link from "next/link";
import { Start } from "./landing";

export function Recovery({
  error,
  resetAt,
  onRetry,
  onEdit,
  onLatest,
  onKeepText,
  disabled = false,
  unresolved = false,
}: {
  error: string;
  resetAt?: number;
  onRetry: () => void;
  onEdit: (target?: "favourites" | "tastes") => void;
  onLatest: () => void;
  onKeepText: () => void;
  disabled?: boolean;
  unresolved?: boolean;
}) {
  const wait = useCooldown(resetAt);
  const stale = error === "This draft changed in another tab.";
  const empty =
    /did not return a choice|Add another favourite|needs another option|There is no other/.test(
      error,
    );
  const unavailable =
    /cannot reach Qloo|Qloo is unavailable|paused for now/.test(error);
  const stopped = error.startsWith("Stopped.");
  const interrupted = unresolved || /connection was interrupted|Check latest version/.test(error);
  const setup = /cannot reach Qloo/.test(error);
  const backToDraft = /could not read|agent could not finish/.test(error);
  const quota = /Qloo needs a short pause|New choices are unavailable/.test(error);
  const rate = /made a few mixtapes quickly/.test(error);
  const paused = /paused for now|New choices are unavailable/.test(error);
  const invalidTaste = error.startsWith("Qloo cannot use ");
  return (
    <div className="recovery" role="alert">
      <p>{error}</p>
      {empty && <p>Add another favourite or change the tastes.</p>}
      {resetAt && (
        <p aria-live="off"><CooldownMessage resetAt={resetAt} /></p>
      )}
      <div className="recovery-actions">
        {stale ? (
          <>
            <button disabled={disabled} onClick={onLatest}>
              Load the latest version
            </button>
            <button onClick={onKeepText}>Keep my text</button>
          </>
        ) : interrupted ? (
          <button disabled={disabled} onClick={onLatest}>
            Check latest version
          </button>
        ) : (
          <>
            {!empty && !paused && !setup && !invalidTaste && (!quota || !!resetAt) && (
              <button disabled={disabled || wait} onClick={onRetry}>
                Try again
              </button>
            )}
            {paused ? <Link prefetch={false} href="/drafts">Open a saved mixtape</Link>
              : quota || rate ? <button onClick={() => onEdit()}>View current mixtape</button>
              : <button disabled={disabled} onClick={() => onEdit(empty ? "favourites" : "tastes")}>
                {empty ? "Edit shelf" : stopped || setup || backToDraft ? "Back to draft" : "Edit tastes"}
              </button>}
            {empty && <button disabled={disabled} onClick={() => onEdit("tastes")}>Edit tastes</button>}
            {(unavailable || paused) && (
              <div><p>Illustrative sample · No live Qloo calls</p><Start fixture sampleId="quiet-evenings" label="Open a sample" /></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
