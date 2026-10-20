"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  current,
  entityDetail,
  eligibility,
  kinds,
  labels,
  singular,
  replacementIndex,
  selectionBlocked,
  type Draft,
  type Kind,
  type RunEvent,
} from "@/lib/domain-view";
import {
  agentRequest,
  awaitWithSignal,
  api,
  message,
  RequestError,
  type PublicRun,
} from "@/lib/client";
import { GiftOpening } from "./gift-opening";
import { useCooldown } from "./use-cooldown";
import { Recovery } from "./recovery";
import { EntitySearch } from "./entity-search";
import { GiftPanels } from "./gift-panels";
import { TasteExampleView, type TasteExample } from "./taste-example";
import { ChoiceChange } from "./choice-change";
import { Sheet } from "./ui/sheet";
import { ShareSheet } from "./share-sheet";
import { RunStatus } from "./run-status";
import { useOnline } from "./network";
import { changedWords, applyWords, wordConflicts, type Words } from "@/lib/draft-text";
export function Composer({ initial, openGift = false, example }: { initial: Draft; openGift?: boolean; example?: TasteExample }) {
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState(""),
    [replacement, setReplacement] = useState(""),
    [editNotice, setEditNotice] = useState(""),
    [resetAt, setResetAt] = useState<number>(),
    [keptWords, setKeptWords] = useState<{ words: Words; base: Draft } | null>(null),
    [saveState, setSaveState] = useState("Draft saved"),
    [busy, setBusy] = useState(false),
    [events, setEvents] = useState<RunEvent[]>([]),
    [run, setRun] = useState<PublicRun | null>(null),
    [pendingRunId, setPendingRunId] = useState<string | null | undefined>(undefined),
    [editShelf, setEditShelf] = useState(false),
    [editTastes, setEditTastes] = useState(false),
    [returnIds, setReturnIds] = useState<string[]>(initial.returnCandidates?.map((e) => e.id) ?? []),
    [noteKind, setNoteKind] = useState<Kind | null>(null),
    [preview, setPreview] = useState(openGift),
    [previewOpened, setPreviewOpened] = useState(false),
    [startedAt, setStartedAt] = useState(0),
    [showInputs, setShowInputs] = useState(!current(initial));
  const draftRef = useRef(draft);
  const savedRef = useRef(initial);
  const lastSaveError = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const noteOpener = useRef<HTMLElement | null>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  function openNote(kind: Kind | null) {
    noteOpener.current = document.activeElement as HTMLElement;
    setNoteKind(kind);
  }
  useEffect(() => { if (noteKind) noteField.current?.focus(); }, [noteKind]);
  const focusNext = useRef<false | "heading" | Kind>(false);
  useEffect(() => {
    if (preview) backButton.current?.focus();
    else if (focusNext.current) {
      if (focusNext.current === "heading") headingRef.current?.focus();
      else document.querySelector<HTMLElement>(`.panels > li[data-kind="${focusNext.current}"] article`)?.focus();
      focusNext.current = false;
    }
  }, [preview, draft.version, showInputs]);
  const editSeq = useRef(0);
  const saveInFlight = useRef<Promise<Draft> | null>(null);
  const runController = useRef<AbortController | null>(null);
  const retrySlot = useRef<Kind | undefined>(undefined);
  const online = useOnline();
  const cooling = useCooldown(resetAt);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionBar = useRef<HTMLDivElement>(null);
  const identityBusy = useRef(false);
  const identityJob = useRef<Promise<void> | null>(null);
  useEffect(() => () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); }, []);
  useEffect(() => {
    const bar = actionBar.current;
    if (!bar) return;
    const measure = () => document.documentElement.style.setProperty("--compose-bar-height", `${bar.getBoundingClientRect().height + 20}px`);
    const observer = new ResizeObserver(measure); observer.observe(bar); measure();
    const reveal = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".composer-inputs") || !target.matches("input, textarea, button, select, summary, a")) return;
      requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const top = bar.getBoundingClientRect().top;
        if (rect.bottom > top - 16) window.scrollBy(0, rect.bottom - top + 24);
      });
    };
    document.addEventListener("focusin", reveal);
    return () => { observer.disconnect(); document.removeEventListener("focusin", reveal); document.documentElement.style.removeProperty("--compose-bar-height"); };
  }, [showInputs, preview, draft.returnCandidates, busy]);
  useEffect(() => { if (previewOpened) headingRef.current?.focus(); }, [previewOpened]);
  const result = current(draft),
    count = result?.slots.length ?? draft.categories.length;
  useEffect(() => {
    if (saveState === "Draft saved") return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [saveState]);
  const pendingSelection = !!result && (JSON.stringify(result.slots.map((s) => s.kind)) !== JSON.stringify(draft.categories) || result.slots.some((s) => (s.previousTastes || s.previousShelf) && !s.locked));
  const update = (d: Draft) => {
    savedRef.current = d;
    draftRef.current = d;
    setDraft(d);
    setSaveState("Draft saved");
  };
  function receiveRun(value: PublicRun) {
    setRun(value);
    setPendingRunId(value.id);
    try { sessionStorage.setItem(`mixtape-run:${initial.id}`, value.id); } catch {}
  }
  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;
    try { id = sessionStorage.getItem(`mixtape-run:${initial.id}`); } catch {}
    const storedId = id;
    void Promise.resolve().then(() => { if (!cancelled) setPendingRunId(storedId); });
    if (!id) return;
    const sequence = editSeq.current;
    void api<PublicRun>(`/api/runs/${id}`, "GET").then(async (latest) => {
      if (cancelled) return;
      setRun(latest); setEvents(latest.events); setResetAt(latest.failure?.resetAt);
      if (["accepted", "running"].includes(latest.status)) setError("The connection was interrupted.");
      else if (latest.error) setError(latest.error);
      else if (latest.status === "ready" && (latest.resultVersion ?? 0) > initial.version) {
        const next = await api<Draft>(`/api/drafts/${initial.id}`, "GET");
        if (cancelled) return;
        if (sequence !== editSeq.current) {
          setError("Your latest edits are still here. Check latest version before making new choices.");
          return;
        }
        savedRef.current = next; draftRef.current = next; setDraft(next);
        setShowInputs(!current(next));
      }
      if (!cancelled && !["accepted", "running"].includes(latest.status)) setPendingRunId(null);
    }).catch(async (error) => {
      if (cancelled) return;
      if (error instanceof RequestError && error.status === 404) {
        try {
          const next = await api<Draft>(`/api/drafts/${initial.id}`, "GET");
          if (!cancelled) {
            if (sequence !== editSeq.current) setError("Your latest edits are still here. Check latest version before making new choices.");
            else { savedRef.current = next; draftRef.current = next; setDraft(next); setPendingRunId(null); }
          }
          return;
        } catch {}
      }
      if (!cancelled) setError("The connection was interrupted. Check latest version before making new choices.");
    });
    return () => { cancelled = true; };
  }, [initial.id, initial.version]);
  useEffect(() => { if (pendingRunId === null) { try { sessionStorage.removeItem(`mixtape-run:${initial.id}`); } catch {} } }, [pendingRunId, initial.id]);
  async function refresh() {
    const next = await api<Draft>(`/api/drafts/${draft.id}`, "GET");
    update(next);
    return next;
  }
  async function save(extra: Record<string, unknown> = {}, signal?: AbortSignal) {
    if (identityJob.current) await awaitWithSignal(identityJob.current, signal);
    while (saveInFlight.current) await awaitWithSignal(saveInFlight.current, signal);
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const delta = changedWords(savedRef.current, draftRef.current);
    const formatChanged = JSON.stringify(draftRef.current.categories) !== JSON.stringify(savedRef.current.categories);
    if (!Object.keys(extra).length && !Object.keys(delta).length && !formatChanged) { setSaveState("Draft saved"); return savedRef.current; }
    if (!online) throw new Error("Your latest edits are not saved yet.");
    setSaveState("Saving…");
    const d = draftRef.current;
    const sequence = editSeq.current;
    const job = api<Draft>(`/api/drafts/${d.id}`, "PATCH", {
      expectedVersion: d.version,
      ...changedWords(savedRef.current, d),
      ...(JSON.stringify(d.categories) !== JSON.stringify(savedRef.current.categories) ? { categories: d.categories } : {}),
      ...extra,
    }, signal);
    saveInFlight.current = job;
    try {
      const next = await job;
      setError((previous) => previous === lastSaveError.current ? "" : previous);
      lastSaveError.current = null;
      if (sequence === editSeq.current) update(next);
      else {
        const pending = draftRef.current;
        const merged = { ...applyWords(next, changedWords(d, pending)), categories: pending.categories };
        savedRef.current = next;
        draftRef.current = merged;
        setDraft(merged);
        setSaveState("Your latest edits are not saved yet.");
      }
      return next;
    } catch (e) {
      setSaveState("Your latest edits are not saved yet.");
      lastSaveError.current = message(e);
      setError(message(e));
      if (e instanceof RequestError) setResetAt(e.resetAt);
      throw e;
    } finally {
      saveInFlight.current = null;
    }
  }
  function edit(fn: (d: Draft) => Draft) {
    editSeq.current++;
    const next = fn(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    setSaveState("Your latest edits are not saved yet.");
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { if (!identityBusy.current) void save().catch(() => {}); }, 650);
  }
  async function confirmEntity(resultRef: string, list: "shelf" | "tastes") {
    if (identityJob.current) await identityJob.current;
    identityBusy.current = true;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const job = (async () => {
      if (saveInFlight.current) await saveInFlight.current.catch(() => {});
      const base = savedRef.current;
      const next = await api<Draft>(`/api/drafts/${base.id}/confirm-entity`, "POST", { expectedVersion: base.version, resultRef, list });
      const pending = draftRef.current;
      const words = changedWords(base, pending);
      const merged = { ...applyWords(next, words), categories: pending.categories };
      savedRef.current = next; draftRef.current = merged; setDraft(merged);
      setSaveState(Object.keys(words).length || JSON.stringify(next.categories) !== JSON.stringify(merged.categories) ? "Your latest edits are not saved yet." : "Draft saved");
    })();
    identityJob.current = job;
    try { await job; } finally { identityBusy.current = false; identityJob.current = null; }
  }
  async function removeEntity(list: "shelf" | "tastes", id: string, title: string, button: HTMLButtonElement) {
    const row = button.closest("li");
    const target = row?.nextElementSibling?.querySelector<HTMLButtonElement>("button") ?? row?.previousElementSibling?.querySelector<HTMLButtonElement>("button") ?? button.closest("section")?.querySelector<HTMLInputElement>("[role=combobox]");
    try { await save({ remove: { list, id } }); setEditNotice(`${title} was removed.`); requestAnimationFrame(() => target?.focus()); } catch {}
  }
  async function prepare(slotId?: Kind) {
    if (busy || identityBusy.current || cooling || pendingRunId !== null) return;
    if (run && ["accepted", "running"].includes(run.status)) {
      setError("The connection was interrupted.");
      return;
    }
    setRun(null);
    retrySlot.current = slotId;
    setError("");
    setResetAt(undefined);
    setBusy(true);
    setStartedAt(() => Date.now());
    setEvents([]);
    runController.current = new AbortController();
    const deadline = AbortSignal.timeout(45000);
    const signal = AbortSignal.any([runController.current.signal, deadline]);
    try {
      const saved = await save({}, signal);
      const r = await agentRequest(
        {
          action: slotId ? "repair" : result ? "refine" : "prepare",
          draftId: saved.id,
          slotId,
          expectedVersion: saved.version,
          idempotencyKey: crypto.randomUUID(),
        },
        receiveRun,
        (e) => setEvents((v) => [...v, e]),
        signal,
      );
      if (r.status === "ready") {
        const next = await refresh();
        if (slotId) {
          const before = result?.slots.find((s) => s.kind === slotId);
          const after = current(next)?.slots.find((s) => s.kind === slotId);
          if (before && after)
            setReplacement(
              `${before.entity.name} was replaced with ${after.entity.name}.`,
            );
        }
        setShowInputs(false);
        focusNext.current = slotId ?? "heading";
      } else if (r.error) { setError(r.error); setResetAt(r.failure?.resetAt); }
      else if (r.status === "needs_input") {
        await refresh();
        setError(
          r.events.findLast((e) => e.type === "needs_input")?.label ??
            "Add another favourite or change the tastes.",
        );
      }
      setPendingRunId(null);
    } catch (e) {
      if (e instanceof RequestError) setResetAt(e.resetAt);
      setError(
        runController.current?.signal.aborted
          ? "Stopped. Your draft is still here."
          : deadline.aborted ? "This is taking longer than it should. Your draft is safe." : message(e),
      );
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) (document.querySelector<HTMLButtonElement>(".make-button:not(:disabled)") ?? document.querySelector<HTMLButtonElement>(".recovery button:not(:disabled)"))?.focus();
      });
    }
  }
  const compactSample = !!draft.sampleId && !result && initial.shelf.length > 0 && initial.tastes.length > 0;
  function openEditor(target: "favourites" | "tastes") {
    setShowInputs(true);
    if (target === "favourites") setEditShelf(true); else setEditTastes(true);
    requestAnimationFrame(() => document.getElementById(target)?.querySelector<HTMLInputElement>("input[role=combobox]")?.focus());
  }
  const partialSlots =
    run?.status === "needs_input" ? (run.partialSlots ?? []) : [];
  const missingKind =
    draft.categories.find((k) => !partialSlots.some((s) => s.kind === k)) ??
    "movie";
  const missingFavourites = Math.max(0, 6 - draft.shelf.length,
    draft.categories.reduce((n, kind) => n + Math.max(0, 2 - eligibility(draft, kind).length), 0));
  const noteSlot = result?.slots.find((s) => s.kind === noteKind);
  const missingNotes = result?.slots.filter((s) => !s.note.trim()) ?? [];
  const missingTastes = Math.max(0, 3 - draft.tastes.length);
  const invalid =
    draft.tastes.length < 3 ||
    draft.shelf.length < 6 ||
    draft.categories.some((k) => eligibility(draft, k).length < 2);
  if (preview && result)
    return (
      <section
        className={`receiver ${previewOpened ? "receiver-opened" : "receiver-closed"}`}
      >
        {draft.mode === "fixture" && (
          <p className="fixture-notice">Sample mode · No live Qloo calls</p>
        )}
        <p className="eyebrow">{openGift ? "Fictional exchange · Your private sample" : "Preview · Only you can see this draft"}</p>
        <button ref={backButton} className="preview-back" onClick={() => { setPreview(false); requestAnimationFrame(() => previewButton.current?.focus()); }}>
          {openGift ? "Make this yours / share" : "Back to editing"}
        </button>
        <h1 ref={headingRef} tabIndex={-1}>
          {previewOpened
            ? `From ${draft.sender || "you"}, for ${draft.recipient || "your friend"}`
            : `${draft.sender || "Your friend"} made you a mixtape.`}
        </h1>
        {draft.introduction && !previewOpened && (
          <div className="letter">
            <div className="letter-top">
              <span>FROM {draft.sender || "YOU"}</span>
              <span>TO {draft.recipient || "YOUR FRIEND"}</span>
            </div>
            <p className="human-note">{draft.introduction}</p>
            <span className="signature">— {draft.sender || "You"}</span>
          </div>
        )}
        {previewOpened ? (
          <div className="opened gift-arriving">
            <p className="keepsake-note">{draft.introduction}<span> — {draft.sender}</span></p>
            <TasteExampleView example={example} />
            <GiftPanels slots={result.slots} sender={draft.sender} recipient />
          </div>
        ) : (
          <GiftOpening sender={draft.sender} recipient={draft.recipient} categories={result.slots.map((s) => s.kind)} onReveal={() => setPreviewOpened(true)} />
        )}
      </section>
    );
  return (
    <div
      className={`composer ${compactSample ? "compact-sample" : ""} ${draft.returnCandidates ? "is-returning" : result && !showInputs ? "has-result" : "is-editing"}`}
    >
      {draft.mode === "fixture" && (
        <p className="fixture-notice">Sample mode · No live Qloo calls</p>
      )}
      <p className="eyebrow">
        {result ? "Your personal edition" : "01 · Make it personal"}
      </p>
      {draft.sampleId && (
        <p className="fictional">
          Fictional exchange · You can change every taste.
        </p>
      )}
      <h1 ref={headingRef} tabIndex={-1}>
        {draft.returnCandidates
          ? "Now, one from you."
          : result
            ? `From ${draft.sender || "you"}, for ${draft.recipient || "your friend"}`
            : draft.recipient
              ? `A mixtape for ${draft.recipient}`
              : "Start with what you love."}
      </h1>
      {result && (
        <div className="result-toolbar">
          <div>
            <p>
              {count === 3 ? "Three" : "Two"} of your favourites, chosen for
              them.{draft.mode === "live" && " Connections by Qloo."}
            </p>
            {replacement && <p role="status">{replacement}</p>}
            {pendingSelection && <p>Update their mixtape before sharing these choices.</p>}
            {result.slots.some((s) => !s.note.trim()) && <p className="notes-needed">{result.slots.filter((s) => s.note.trim()).length} of {count} personal notes ready. <button onClick={() => {
              openNote(result.slots.find((s) => !s.note.trim())?.kind ?? null);
            }}>Add your notes</button></p>}
          </div>
          <div className="toolbar-actions">
            <details className="edition-menu"><summary>Edit edition</summary><button disabled={busy} aria-expanded={showInputs} aria-controls="composer-inputs" onClick={() => showInputs ? setShowInputs(false) : openEditor("tastes")}>
              {showInputs ? "Close editing" : "Edit tastes"}
            </button></details>
            <button
              ref={previewButton}
              disabled={busy}
              onClick={() => {
                setPreviewOpened(false);
                setPreview(true);
              }}
            >
              Preview opening
            </button>
            <ShareSheet
              triggerRef={shareTrigger}
              draft={draft}
              disabled={busy || saveState === "Saving…" || pendingSelection}
              onBeforeOpen={async () => {
                if (saveState !== "Draft saved") await save();
              }}
              onMissingNotes={() => {
                openNote(result.slots.find((s) => !s.note.trim())?.kind ?? null);
              }}
              onCreated={async () => {
                await refresh();
              }}
            />
          </div>
        </div>
      )}
      <p role="status" className="edit-notice">{editNotice}</p>
      {error && (
        <Recovery
          key={`${error}-${resetAt}`}
          error={error}
          unresolved={typeof pendingRunId === "string"}
          resetAt={resetAt}
          disabled={busy || !online}
          onRetry={() =>
            void (
              saveState === "Your latest edits are not saved yet."
                ? save()
                : prepare(retrySlot.current)
            ).catch(() => {})
          }
          onEdit={(target = "tastes") => {
            setShowInputs(true); setEditShelf(target === "favourites"); setEditTastes(target === "tastes"); setError("");
            requestAnimationFrame(() => document.getElementById(target)?.querySelector<HTMLInputElement>("input[role=combobox]")?.focus());
          }}
          onLatest={() => {
            if (!keptWords) setKeptWords({ words: changedWords(savedRef.current, draftRef.current), base: savedRef.current });
            void (async () => {
              const recoveryId = pendingRunId ?? run?.id;
              if (recoveryId) {
                const latest = await api<PublicRun>(
                  `/api/runs/${recoveryId}`,
                  "GET",
                );
                setRun(latest);
                setEvents(latest.events);
      setResetAt(latest.failure?.resetAt);
                if (["accepted", "running"].includes(latest.status)) return;
              }
              await refresh();
              setPendingRunId(null);
              setError("");
            })().catch(async (error) => {
              if (error instanceof RequestError && error.status === 404) {
                try { await refresh(); setPendingRunId(null); setRun(null); setError(""); return; } catch {}
              }
              setError("The connection was interrupted. Check latest version before making new choices.");
            });
          }}
          onKeepText={() => {
            setKeptWords({ words: changedWords(savedRef.current, draftRef.current), base: savedRef.current });
            setError("");
          }}
        />
      )}
      {keptWords && (
        <div className="kept-words">
          <p>Your words are kept here while you load the latest version.</p>
          {wordConflicts(keptWords.base, draft, keptWords.words).length > 0 && <p role="alert">Both tabs edited: {wordConflicts(keptWords.base, draft, keptWords.words).join(", ")}. Applying your words replaces these fields.</p>}
          <button
            disabled={busy || !online}
            onClick={() => {
              edit((d) => applyWords(d, keptWords.words));
              setKeptWords(null);
            }}
          >
            Apply my words
          </button>
        </div>
      )}
      {draft.returnCandidates && (
        <section>
          <h2>Choose your favourites</h2>
          <p>
            These were entered as your tastes. Keep only the things you really
            love.
          </p>
          <p>Then add one more film, book and artist to give Mixtape a choice.</p>
          <ul>
            {draft.returnCandidates.map((e) => (
              <li key={e.id}><label><input type="checkbox" checked={returnIds.includes(e.id)} onChange={(event) => setReturnIds((ids) => event.target.checked ? [...ids, e.id] : ids.filter((id) => id !== e.id))} />{e.name}</label></li>
            ))}
          </ul>
          <button
            className="primary"
            disabled={busy || !online}
            onClick={() =>
              void save({ confirmReturnFavourites: returnIds }).then(() => openEditor("favourites")).catch(() => {})
            }
          >
            Use selected favourites and continue
          </button>
          <button
            disabled={busy}
            onClick={() => void save({ skipReturnFavourites: true }).then(() => openEditor("favourites")).catch(() => {})}
          >
            Start with an empty shelf
          </button>
        </section>
      )}
      {!draft.returnCandidates && (showInputs || !result) && (
        <section id="composer-inputs" className="composer-inputs" aria-label="Composer">
          {compactSample && <p className="sample-brief"><span>{draft.sender} brings {draft.shelf.length} favourites.</span><strong>Which three belong in {draft.recipient}’s world?</strong></p>}
          {draft.shelf.length > 0 && draft.categories.some((k) => eligibility(draft, k).length < 2) && <p className="coverage-help">{draft.shelf.length} favourites added. Add {draft.categories.filter((k) => eligibility(draft, k).length < 2).map((k) => `${eligibility(draft, k).length === 1 ? "one more" : "two"} ${singular[k]}${eligibility(draft, k).length === 0 ? "s" : ""}`).join(", ")} to give us a choice.</p>}
          <details className="format-details"><summary>{draft.categories.length} pieces · {draft.categories.map((k) => singular[k]).join(" + ")} <span>Change</span></summary><fieldset className="format" disabled={busy || !online}>
            <legend className="sr-only">What goes in?</legend>
            {kinds.map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={draft.categories.includes(k)}
                  disabled={
                    draft.categories.length === 2 &&
                    draft.categories.includes(k)
                  }
                  onChange={(e) => {
                    const selected = e.target.checked
                      ? [...draft.categories, k]
                      : draft.categories.filter((x) => x !== k);
                    const ordered = kinds.filter((x) => selected.includes(x));
                    edit((d) => ({ ...d, categories: ordered }));
                  }}
                />
                {labels[k]}
              </label>
            ))}
          </fieldset></details>
          <div className="columns">
            <section id="favourites" tabIndex={-1} className="shelf-section">
              <h2>{compactSample ? `${draft.sender || "Your"}’s favourites` : "Your favourites"}</h2>
              <p>{draft.shelf.length} favourites · 6 needed, 12 maximum</p>
              {compactSample && !editShelf ? <>
                <details className="sample-shelf-review" open><summary>Look through the {draft.shelf.length} favourites</summary><div className="sample-shelf-groups">{kinds.map((kind) => <section key={kind}><h3>{kind === "movie" ? "Films" : kind === "book" ? "Books" : "Artists"}</h3><ul>{draft.shelf.filter((e) => e.entity.kind === kind).map((e) => <li key={e.entity.id}>{e.entity.name}</li>)}</ul></section>)}</div></details>
                <button onClick={() => openEditor("favourites")}>Edit favourites</button>
              </> : <>

              <p>
                Choose two favourites of each kind. Then add three short notes and send.
              </p>
              <EntitySearch
                draft={draft}
                list="shelf"
                onConfirm={confirmEntity}
                disabled={busy}
              />
              {!draft.shelf.length && (
                <>
                  <h3>Your shelf starts here.</h3>
                  <p>Add a film, a book or an artist you love.</p>
                </>
              )}
              <details className="shelf-inventory" open={draft.categories.some((k) => eligibility(draft, k).length < 2) ? true : undefined}>
                <summary>Review your favourites <span>{kinds.map((k) => `${draft.shelf.filter((e) => e.entity.kind === k).length} ${singular[k]}${draft.shelf.filter((e) => e.entity.kind === k).length === 1 ? "" : "s"}`).join(" · ")}</span></summary>
              <ul className="shelf-list">
                {draft.shelf.map((e) => (
                  <li key={e.entity.id}>
                    <div className="entity-identity">
                      <span className="eyebrow">{singular[e.entity.kind]}</span>
                      <strong>{e.entity.name}</strong>
                      {entityDetail(e.entity) && <small>{entityDetail(e.entity)}</small>}
                    </div>
                    <button
                      aria-label={`Remove ${e.entity.name}`}
                      disabled={busy || !online}
                      onClick={(event) => void removeEntity("shelf", e.entity.id, e.entity.name, event.currentTarget)}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                    <details className="note-editor">
                      <summary aria-label={`${e.note ? "Edit your note" : "Add a note"} for ${e.entity.name}`}>
                        {e.note ? "Edit your note" : "Add a note"}
                      </summary>
                      <label>
                        Why I love this
                        <textarea
                          aria-label={`Why I love this: ${e.entity.name}`}
                          maxLength={240}
                          placeholder="What would you want them to notice?"
                          value={e.note}
                          disabled={busy || !online}
                          onChange={(ev) =>
                            edit((d) => ({
                              ...d,
                              shelf: d.shelf.map((x) =>
                                x.entity.id === e.entity.id
                                  ? { ...x, note: ev.target.value }
                                  : x,
                              ),
                            }))
                          }
                          onBlur={() => void save().catch(() => {})}
                        />
                      </label>
                    </details>
                  </li>
                ))}
              </ul>
              </details>
              </>}
            </section>
            <section id="tastes" tabIndex={-1} className="tastes-section">
              <h2>{compactSample ? `${draft.recipient || "Your friend"}’s tastes` : "Their tastes"}</h2>
              <p>{draft.tastes.length} of 5 tastes</p>
              {(compactSample || (initial.returnCandidates && draft.tastes.length >= 3)) && !editTastes ? <>
                <ul className="sample-taste-summary">{draft.tastes.map((e) => <li key={e.id} className={e.imageUrl ? "with-taste-art" : undefined}>{e.imageUrl && <Image className="taste-thumb" src={e.imageUrl} alt="" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} width={44} height={60} unoptimized referrerPolicy="no-referrer" />}<small>{labels[e.kind]}</small><strong>{e.name}</strong>{entityDetail(e) && <span>{entityDetail(e)}</span>}</li>)}</ul>
                <button onClick={() => openEditor("tastes")}>Edit tastes</button>
              </> : <>

              {initial.returnCandidates && <p>We started with the favourites they sent you. You can change them.</p>}
              <p>
                Add three things you know they like, or let them fill these in
                with you.
              </p>
              {!draft.tastes.length && <h3>What do they keep recommending?</h3>}
              <EntitySearch
                draft={draft}
                list="tastes"
                onConfirm={confirmEntity}
                disabled={busy}
              />
              <ul className="taste-list">
                {draft.tastes.map((e) => (
                  <li key={e.id}>
                    <div className="entity-identity">
                      <span className="eyebrow">{singular[e.kind]}</span>
                      <strong>{e.name}</strong>
                      {entityDetail(e) && <small>{entityDetail(e)}</small>}
                    </div>
                    <button
                      disabled={busy || !online}
                      aria-label={`Remove ${e.name}`}
                      onClick={(event) => void removeEntity("tastes", e.id, e.name, event.currentTarget)}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p>Only add tastes they have shared with you.</p>
              <p>
                {draft.declaredBy === "recipient"
                  ? "Entered by the recipient"
                  : `Entered by ${draft.sender || "you"}`}
              </p>
              </>}
            </section>
          </div>
          <details className="personal-details" open={!compactSample ? true : undefined}><summary>Names & personal message</summary>
          <fieldset className="people" disabled={busy || !online}>
            <legend className="sr-only">People</legend>
            <label>
              From
              <input
                placeholder="Your first name"
                maxLength={40}
                value={draft.sender}
                onChange={(e) =>
                  edit((d) => ({ ...d, sender: e.target.value }))
                }
                onBlur={() => void save().catch(() => {})}
              />
            </label>
            <label>
              To
              <input
                placeholder="Their first name"
                maxLength={40}
                value={draft.recipient}
                onChange={(e) =>
                  edit((d) => ({ ...d, recipient: e.target.value }))
                }
                onBlur={() => void save().catch(() => {})}
              />
            </label>
          </fieldset>
          <label>
            A line from you
            <textarea
              maxLength={240}
              placeholder="What made you want to send this?"
              value={draft.introduction}
              disabled={busy || !online}
              onChange={(e) =>
                edit((d) => ({ ...d, introduction: e.target.value }))
              }
              onBlur={() => void save().catch(() => {})}
            />
          </label>
          <p>This is your note. Mixtape will not write it for you.</p>

          </details>

          {result && (
            <p>Your current mixtape stays until you make a new one.</p>
          )}
        </section>
      )}
      {!draft.returnCandidates && (showInputs || !result || busy) && (
        <div className={`compose-actions${busy ? " is-busy" : ""}`} ref={actionBar}>
          {busy ? (        <RunStatus
          key={startedAt}
          mode={draft.mode}
          events={events}
          busy={busy}
          startedAt={startedAt}
          onStop={() => {
            runController.current?.abort();
            if (run)
              void api(`/api/runs/${run.id}/cancel`).catch((e) =>
                setError(message(e)),
              );
          }}
        />) : <>
          <span className="action-save-status" role="status">{saveState}</span>
          <p>
            {invalid
              ? [
                  missingFavourites > 0
                    ? `Add ${missingFavourites} more favourite${missingFavourites === 1 ? "" : "s"}`
                    : "",
                  missingTastes > 0
                    ? `Add ${missingTastes} more taste${missingTastes === 1 ? "" : "s"}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" and ")
                  .replace(/ and Add /, " and ") + " to continue."
              : ""}
          </p>
          <button
            className="primary make-button"
            disabled={busy || cooling || invalid || !online || pendingRunId !== null || draft.categories.some((kind) => !result?.slots.find((s) => s.kind === kind)?.locked && selectionBlocked(draft, kind))}
            onClick={() => void prepare()}
          >
            {result ? "Update their mixtape" : "Make their mixtape"}
          </button>
          </>}
        </div>
      )}
      {result && (
        <section>
          <ChoiceChange draft={draft} />
          <TasteExampleView example={example} />
          <GiftPanels
            slots={result.slots}
            sender={draft.sender}
            noteEditor={(s) => <button className="note-editor-trigger" aria-label={`${s.note ? "Edit your note" : "Add a note"} for ${s.entity.name}`} onClick={() => openNote(s.kind)}>{s.note ? "Edit your note" : "Add a note"}</button>}
            actions={(s) => (
              <>
                <button
                  className="action-replace"
                  disabled={busy || cooling || !online || pendingRunId !== null || selectionBlocked(draft, s.kind, true)}
                  onClick={() => void prepare(s.kind)}
                >
                  Try another
                </button>
                <button
                  className="action-keep"
                  aria-pressed={s.locked}
                  disabled={busy || !online}
                  onClick={() =>
                    void save({
                      lock: { kind: s.kind, locked: !s.locked },
                    }).catch(() => {})
                  }
                >
                  {s.locked ? "Let Mixtape choose" : "Keep this"}
                </button>

              </>
            )}
          />
          <div className="result-end"><p>{missingNotes.length ? "A few words make it yours." : "Ready to send?"}</p><button className="primary" disabled={busy || saveState === "Saving…" || pendingSelection || !online} onClick={() => shareTrigger.current?.click()}>{missingNotes.length ? `Add ${missingNotes.length} note${missingNotes.length === 1 ? "" : "s"}` : "Create share link"}</button></div>
          {replacementIndex(draft.revisions) > 0 && <button
            className="action-undo"
            disabled={busy || !online}
            onClick={async () => {
              try {
                const kind = draft.revisions[replacementIndex(draft.revisions)]?.replacementKind;
                const saved = await save();
                update(
                  await api<Draft>(`/api/drafts/${draft.id}/undo`, "POST", {
                    expectedVersion: saved.version,
                  }),
                );
                setReplacement("The earlier piece is back.");
                requestAnimationFrame(() => document.querySelector<HTMLElement>(`.panels > li[data-kind="${kind}"] article`)?.focus());
              } catch (e) {
                setError(message(e));
              }
            }}
          >
            Undo replacement
          </button>}
        </section>
      )}
      {partialSlots.length > 0 && (
        <section className="partial-preview">
          <p className="eyebrow">Unfinished draft</p>
          <h2>
            We have {partialSlots.length} pieces. This {singular[missingKind]}{" "}
            needs another option.
          </h2>
          <p>Add another favourite or change the tastes.</p>
          <GiftPanels slots={partialSlots} sender={draft.sender} />
          <button
            onClick={() => openEditor("favourites")}
          >
            Add a favourite
          </button>
          <button onClick={() => setShowInputs(true)}>Keep editing</button>
          {partialSlots.length === 2 && (
            <>
              <p>
                This version will have{" "}
                {partialSlots.map((s) => singular[s.kind]).join(" and ")}.
              </p>
              <button
                className="primary"
                disabled={busy || !online}
                onClick={() => {
                  edit((d) => ({
                    ...d,
                    categories: kinds.filter((k) =>
                      partialSlots.some((s) => s.kind === k),
                    ),
                  }));
                  void prepare();
                }}
              >
                Make a two-piece mixtape
              </button>
            </>
          )}
        </section>
      )}
      <p className="save-status" role={showInputs ? undefined : "status"}>
        {saveState}
      </p>
      {saveState === "Your latest edits are not saved yet." && (
        <button
          disabled={busy || !online}
          onClick={() => void save().catch(() => {})}
        >
          Try saving again
        </button>
      )}
      {draft.mode === "fixture" && (
        <p>
          These choices are illustrative. They are not Qloo recommendations.
        </p>
      )}
      {run && run.model === "deterministic-local-stub" && (
        <p className="fine-print">
          {draft.mode === "fixture"
            ? "Sample selection · No model calls"
            : "Local selection agent · No model calls"}
        </p>
      )}
      {!busy && events.length > 0 && (
        <RunStatus
          key={startedAt}
          mode={draft.mode}
          events={events}
          busy={busy}
          startedAt={startedAt}
          onStop={() => {
            runController.current?.abort();
            if (run)
              void api(`/api/runs/${run.id}/cancel`).catch((e) =>
                setError(message(e)),
              );
          }}
        />
      )}
      <Sheet finalFocus={() => noteOpener.current?.isConnected ? noteOpener.current : shareTrigger.current} title={noteSlot ? `Your note for ${noteSlot.entity.name}` : "Your notes"} open={!!noteSlot} onOpenChange={(open) => { if (!open) { setNoteKind(null); void save().catch(() => {}); } }}>
        {noteSlot && <>
          <p className="eyebrow">{result!.slots.findIndex((s) => s.kind === noteKind) + 1} of {result!.slots.length} · A few words make it yours</p>
          <label>Why I love this<textarea ref={noteField} key={noteKind} className="focused-note" maxLength={240} disabled={busy || !online} placeholder="What would you want them to notice?" autoFocus
            value={draft.shelf.find((e) => e.entity.id === noteSlot.entity.id)?.note ?? noteSlot.note}
            onChange={(e) => edit((d) => ({ ...d, shelf: d.shelf.map((x) => x.entity.id === noteSlot.entity.id ? { ...x, note: e.target.value } : x) }))} /></label>
          <p role="status">{saveState}</p>
          <button className="primary" disabled={busy || !online} onClick={async () => {
            try { await save(); const index = result!.slots.findIndex((s) => s.kind === noteKind); setNoteKind(result!.slots[index + 1]?.kind ?? null); } catch {}
          }}>{result!.slots.at(-1)?.kind === noteKind ? "Done" : "Save & next note"}</button>
        </>}
      </Sheet>
    </div>
  );
}
