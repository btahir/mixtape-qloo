"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  kinds,
  entityDetail,
  eligibility,
  labels,
  singular,
  type Draft,
  type Entity,
  type Kind,
} from "@/lib/domain-view";
import { api, message, RequestError } from "@/lib/client";
import { useOnline } from "./network";
import { CooldownMessage, useCooldown } from "./use-cooldown";
export function EntitySearch({
  draft,
  list,
  onConfirm,
  disabled,
}: {
  draft: Draft;
  list: "shelf" | "tastes";
  onConfirm: (resultRef: string, list: "shelf" | "tastes") => Promise<void>;
  disabled: boolean;
}) {
  const [kind, setKind] = useState<Kind>(() => list === "shelf" ? draft.categories.find((k) => eligibility(draft, k).length < 2) ?? "movie" : "movie"),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<{ entity: Entity; resultRef: string }[]>(
      [],
    ),
    [status, setStatus] = useState(""),
    [failed, setFailed] = useState(false),
    [active, setActive] = useState(-1),
    [confirming, setConfirming] = useState(false),
    [retry, setRetry] = useState(0),
    [resetAt, setResetAt] = useState<number>();
  const cooling = useCooldown(resetAt);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId(),
    online = useOnline();
  useEffect(() => {
    if (!results.length || document.activeElement !== inputRef.current) return;
    const input = inputRef.current;
    const row = document.getElementById(`${id}-option-${Math.min(1, results.length - 1)}`);
    if (!input || !row) return;
    const bottom = document.querySelector(".compose-actions")?.getBoundingClientRect().top ?? innerHeight;
    if (row.getBoundingClientRect().bottom > Math.min(bottom, window.visualViewport?.height ?? innerHeight) - 16)
      input.scrollIntoView({ block: "start", behavior: "instant" });
  }, [results, id]);
  useEffect(() => {
    if (results[active])
      document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, results, id]);
  useEffect(() => {
    if (query.trim().length < 2 || disabled || !online || (resetAt && resetAt > Date.now())) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("Searching…");
      setFailed(false);
      setResults([]);
      setActive(-1);
      try {
        const v = await api<{ results: { entity: Entity; resultRef: string }[] }>("/api/entities/search", "POST", { query: query.trim(), kind, draftId: draft.id }, controller.signal);
        if (!controller.signal.aborted) {
          setResults(v.results);
          setStatus(
            v.results.length
              ? `${v.results.length} ${v.results.length === 1 ? "match" : "matches"} found. Choose one to confirm.`
              : draft.mode === "fixture"
                ? "This sample does not include that taste. Try live mode when it is available."
                : "We could not find that in Qloo.",
          );
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setFailed(true);
          if (e instanceof RequestError) setResetAt(e.resetAt);
          setStatus(
            e instanceof RequestError && e.status === 429 ? e.message : e instanceof Error && e.message.includes("sample")
              ? e.message
              : "Search is unavailable right now.",
          );
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, kind, draft.id, draft.mode, disabled, online, retry, resetAt]);
  async function choose(i: number) {
    if (!results[i] || confirming || disabled || !online) return;
    setConfirming(true);
    try {
      await onConfirm(results[i].resultRef, list);
      setQuery("");
      setResults([]);
      setActive(-1);
      setFailed(false);
      setStatus(`${results[i].entity.name} was added.`);
      if (list === "shelf" && eligibility(draft, kind).length + 1 >= 2) {
        const next = draft.categories.find((k) => k !== kind && eligibility(draft, k).length < 2);
        if (next) setKind(next);
      }
    } catch (e) {
      setFailed(true);
      setStatus(message(e));
    } finally {
      setConfirming(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }
  return (
    <div className="entity-search">
      <div
        className="kind-tabs"
        role="group"
        aria-label={list === "shelf" ? "Favourite category" : "Taste category"}
      >
        {kinds.map((k) => (
          <button
            key={k}
            aria-pressed={kind === k}
            disabled={disabled || !online || confirming}
            onClick={() => {
              setFailed(false);
              setKind(k);
              setResults([]);
              setQuery("");
              setStatus("");
              setActive(-1);
            }}
          >
            {k === "movie" ? "Films" : k === "book" ? "Books" : "Artists"}{list === "shelf" && <small aria-hidden="true"> {Math.min(2, eligibility(draft, k).length)}/2</small>}
          </button>
        ))}
      </div>
      <label htmlFor={id}>{list === "shelf" && eligibility(draft, kind).length < 2 ? `${eligibility(draft, kind).length === 1 ? "One more" : "Two"} ${singular[kind]}${eligibility(draft, kind).length === 1 ? "" : "s"} you love` : "Find a favourite"}</label>
      <input
        ref={inputRef}
        id={id}
        placeholder="Search by title or name"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-label={`Find a favourite: ${list === "shelf" ? "Your favourites" : "Their tastes"}`}
        aria-activedescendant={
          results[active] ? `${id}-option-${active}` : undefined
        }
        value={query}
        maxLength={120}
        disabled={disabled || !online}
        readOnly={confirming}
        onChange={(e) => {
          setFailed(false);
          setQuery(e.target.value);
          setActive(-1);
          setResults([]);
          setStatus("");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((v) => Math.min(results.length - 1, v + 1));
          }
          if (e.key === "ArrowUp" && results.length) {
            e.preventDefault();
            setActive((v) => Math.max(0, v - 1));
          }
          if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            void choose(active);
          }
          if (e.key === "Escape") { setResults([]); setActive(-1); }
        }}
      />
      {results.length > 1 && <p>Which {singular[kind]} did you mean?</p>}
      <ul id={`${id}-list`} role="listbox" aria-label={labels[kind]}>
        {results.map((r, i) => (
          <li
            key={r.resultRef}
            id={`${id}-option-${i}`}
            role="option"
            aria-selected={active === i}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void choose(i)}
            aria-disabled={disabled || !online || confirming}
          >
            <span className="search-identity">
              {r.entity.name} · {singular[r.entity.kind]} · {entityDetail(r.entity) || "Details unavailable"}
            </span>
            <span className="search-confirm">
              Use this
            </span>
          </li>
        ))}
      </ul>
      <p id={`${id}-status`} role={failed ? "alert" : "status"}>{status}</p>
      {resetAt && <p aria-live="off"><CooldownMessage resetAt={resetAt} /></p>}
      {(failed || resetAt) && (
        <button
          disabled={disabled || !online || cooling}
          onClick={() => { setResetAt(undefined); setRetry((v) => v + 1); }}
        >
          Try again
        </button>
      )}
      {status === "We could not find that in Qloo." && (
        <p>Try the full title, an artist name, or another favourite.</p>
      )}
    </div>
  );
}
