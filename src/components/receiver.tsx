"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  singular,
  type Draft,
  type Gift,
  type Kind,
  type RunEvent,
} from "@/lib/domain-view";
import { agentRequest, api, message, RequestError, type PublicRun } from "@/lib/client";
import { GiftOpening } from "./gift-opening";
import { GiftPanels } from "./gift-panels";
import { RunStatus } from "./run-status";
import { Sheet } from "./ui/sheet";
import { useOnline } from "./network";
import { CooldownMessage, useCooldown } from "./use-cooldown";
import { TasteExampleView, type TasteExample } from "./taste-example";
const expiryFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** A private sample opens through its owner's draft; a gift link opens through its token. */
export type SampleSession = { draftId: string; example?: TasteExample; onEdit: () => void };
export function Receiver({ initial, token, ownerDraftId, sample }: { initial: Gift; token?: string; ownerDraftId?: string; sample?: SampleSession }) {
  const router = useRouter();
  const [gift, setGift] = useState(initial),
    [opened, setOpened] = useState(!!initial.receiptId),
    [unwrapping, setUnwrapping] = useState(false),
    [busy, setBusy] = useState(false),
    [mutating, setMutating] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [repair, setRepair] = useState<Kind | null>(null),
    [lastRepair, setLastRepair] = useState<Kind | null>(null),
    [events, setEvents] = useState<RunEvent[]>([]),
    [run, setRun] = useState<PublicRun | null>(null),
    [pendingRunId, setPendingRunId] = useState<string | null | undefined>(undefined),
    [startedAt, setStartedAt] = useState(0),
    [savedOnly, setSavedOnly] = useState(false),
    [resetAt, setResetAt] = useState<number>();
  const online = useOnline();
  const cooling = useCooldown(resetAt);
  const openPath = sample ? `/api/drafts/${sample.draftId}/sample-receipt` : `/api/receive/${token}/open`;
  const pending = pendingRunId !== null || (!!run && ["accepted", "running"].includes(run.status));
  const savedToggle = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOpening = useRef(false);
  const focusSlot = useRef<Kind | null>(null);
  useEffect(() => {
    if (opened && focusOpening.current) {
      focusOpening.current = false;
      heading.current?.focus();
    }
  }, [opened]);
  const runController = useRef<AbortController | null>(null);
  function receiveRun(value: PublicRun) {
    setRun(value);
    setPendingRunId(value.id);
    try { sessionStorage.setItem(`mixtape-receipt-run:${initial.id}:${initial.generation}`, value.id); } catch {}
  }
  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;
    try { id = sessionStorage.getItem(`mixtape-receipt-run:${initial.id}:${initial.generation}`); } catch {}
    const storedId = id;
    void Promise.resolve().then(() => { if (!cancelled) setPendingRunId(storedId); });
    if (!id) return;
    void api<PublicRun>(`/api/runs/${id}`, "GET").then(async (latest) => {
      if (cancelled) return;
      setRun(latest); setEvents(latest.events); setResetAt(latest.failure?.resetAt);
      if (["accepted", "running"].includes(latest.status)) setError("The connection was interrupted.");
      else if (latest.error) setError(latest.error);
      if (!["accepted", "running"].includes(latest.status) && (latest.resultVersion ?? 0) > (initial.version ?? 0)) {
        const next = await api<Gift>(openPath);
        if (!cancelled) { setGift(next); setOpened(true); }
      }
      if (!cancelled && !["accepted", "running"].includes(latest.status)) setPendingRunId(null);
    }).catch(async (error) => {
      if (cancelled) return;
      if (error instanceof RequestError && error.status === 404) {
        try { const next = await api<Gift>(openPath); if (!cancelled) { setGift(next); setPendingRunId(null); } return; } catch {}
      }
      if (!cancelled) setError("The connection was interrupted. Check latest version before making new choices.");
    });
    return () => { cancelled = true; };
  }, [initial.id, initial.generation, initial.version, openPath]);
  useEffect(() => { if (pendingRunId === null) { try { sessionStorage.removeItem(`mixtape-receipt-run:${initial.id}:${initial.generation}`); } catch {} } }, [pendingRunId, initial.id, initial.generation]);
  async function open() {
    try {
      setGift(await api<Gift>(openPath));
    } catch (e) {
      setError(message(e));
      throw e;
    }
  }

  async function action(
    kind: Kind,
    action: "save" | "unsave" | "known" | "decline" | "undo",
    savedEntityId?: string,
  ) {
    if (mutating || busy || !online) return false;
    setMutating(true);
    setError("");
    try {
      const g = await api<Gift>(
        `/api/receipts/${gift.receiptId}/actions`,
        "POST",
        { action, slotId: kind, expectedVersion: gift.version, ...(savedEntityId ? { savedEntityId } : {}) },
      );
      setGift(g);
      if (action === "known" || action === "decline") {
        focusSlot.current = null;
        setLastRepair(kind);
        setRepair(kind);
        setError("");
      }
      if (action === "save") setNotice("Saved in this browser.");
      if (action === "unsave") {
        setNotice(`${(savedEntityId ? gift.savedSlots?.find((s) => s.entity.id === savedEntityId) : gift.slots.find((s) => s.kind === kind))?.entity.name ?? "This piece"} was removed from saved pieces.`);
        if (savedOnly) {
          requestAnimationFrame(() => (document.querySelector<HTMLElement>(".saved-collection button") ?? savedToggle.current)?.focus());
        }
      }
      if (action === "undo") {
        setNotice("The earlier piece is back.");
        if (!repair) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.panels > li[data-kind="${kind}"] article`)?.focus());
      }
      return true;
    } catch (e) {
      setError(message(e));
      if (action === "save" && !navigator.onLine)
        setNotice("This save has not synced yet.");
      return false;
    } finally {
      setMutating(false);
    }
  }
  async function replace() {
    if (!repair || pending || cooling || busy || gift.blockedRepairs?.includes(repair)) return;
    setError("");
    setBusy(true);
    setRun(null);
    setEvents([]);
    setStartedAt(Date.now());
    runController.current = new AbortController();
    try {
      const r = await agentRequest(
        {
          action: "repair",
          receiptRef: gift.receiptId,
          slotId: repair,
          expectedVersion: gift.version,
          idempotencyKey: crypto.randomUUID(),
        },
        receiveRun,
        (e) => setEvents((v) => [...v, e]),
        runController.current.signal,
      );
      if (r.status === "ready") {
        setGift(await api<Gift>(openPath));
        focusSlot.current = repair;
        setNotice(`Another ${singular[repair]}, from the same shelf. The other pieces stayed exactly as they were.`);
        setRepair(null);
      } else if (r.error) { setError(r.error); setResetAt(r.failure?.resetAt); }
      else if (r.status === "needs_input") {
        setGift(await api<Gift>(openPath));
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
          : message(e),
      );
    } finally {
      setBusy(false);
    }
  }
  async function checkLatest() {
    const id = pendingRunId ?? run?.id;
    if (!id) return;
    try {
      const latest = await api<PublicRun>(`/api/runs/${id}`, "GET");
      setRun(latest);
      setEvents(latest.events);
      setResetAt(latest.failure?.resetAt);
      if (latest.status === "ready") {
        setGift(await api<Gift>(openPath));
        focusSlot.current = repair;
        setRepair(null);
        setError("");
      } else if (latest.error) setError(latest.error);
      else if (["accepted", "running"].includes(latest.status)) setError("The connection was interrupted.");
      else { setGift(await api<Gift>(openPath)); setError(""); }
      if (!["accepted", "running"].includes(latest.status)) setPendingRunId(null);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        try { setGift(await api<Gift>(openPath)); setPendingRunId(null); setRun(null); setError(""); return; } catch {}
      }
      setError("The connection was interrupted. Check latest version before making new choices.");
    }
  }
  const latestButton = pending && !busy && <button disabled={!online} onClick={() => void checkLatest()}>Check latest version</button>;
  async function makeOneBack() {
    if (mutating) return;
    setMutating(true);
    try {
      const d = await api<Draft>("/api/drafts", "POST", sample
        ? { source: "return", receiptRef: gift.receiptId }
        : { source: "return", shareRef: token });
      router.push(`/make/${d.id}`);
    } catch (e) {
      setError(message(e));
      setMutating(false);
    }
  }
  const returnDisabled = !online || busy || mutating || !gift.receiptId;
  // One quiet invitation on the sample's middle piece, until the first repair.
  const inviteKind = sample && gift.repairEnabled && gift.receiptId && !gift.undoKind && !gift.known?.length && !gift.declined?.length
    ? gift.slots[Math.min(1, gift.slots.length - 1)]?.kind : undefined;
  return (
    <div
      className={`receiver ${opened ? "receiver-opened" : "receiver-closed"}`}
    >
      {ownerDraftId && <p className="owner-view">Viewing as recipient <Link href={`/make/${ownerDraftId}`}>Back to your draft</Link></p>}
      {gift.mode === "fixture" && (
        <p className="fixture-notice">Sample mode · No live Qloo calls</p>
      )}
      <p className="eyebrow">
        {sample ? `Fictional exchange · You are ${gift.recipient || "the recipient"}` : opened ? "A little of their world" : "The good kind of mail"}
      </p>
      {sample ? <button className="preview-back" onClick={sample.onEdit}>Make this yours / share</button>
        : gift.sampleId && <p className="fictional">Fictional exchange</p>}
      <h1 ref={heading} tabIndex={-1}>
        {opened
          ? `From ${gift.sender || "your friend"}, for ${gift.recipient || "you"}`
          : `${gift.sender || "Your friend"} made you a mixtape.`}
      </h1>
      {gift.introduction && !opened && (
        <div className="letter">
          <div className="letter-top">
            <span>FROM {gift.sender || "YOUR FRIEND"}</span>
            <span>TO {gift.recipient || "YOU"}</span>
          </div>
          <p className="human-note">{gift.introduction}</p>
          <span className="signature">— {gift.sender || "Your friend"}</span>
        </div>
      )}
      {!opened ? (
        <GiftOpening sender={gift.sender} recipient={gift.recipient} categories={gift.slots.map((s) => s.kind)} disabled={!online} onOpen={open} onReveal={() => {
          focusOpening.current = true; setUnwrapping(true); setOpened(true);
        }} />
      ) : (
        <>
          {gift.introduction && <p className="keepsake-note">{gift.introduction}<span> — {gift.sender || "Your friend"}</span></p>}
          <button className="return-gift" disabled={returnDisabled} onClick={() => void makeOneBack()}>
            Make one back
          </button>
          {sample && <TasteExampleView example={sample.example} />}
          {!gift.receiptId && <p role="status">This gift is read-only right now. You can still explore every piece.</p>}
          <div className={`opened${unwrapping ? " gift-arriving" : ""}`} onAnimationEnd={(event) => { if (event.animationName === "insert-arrives" && (event.target as HTMLElement).closest("li")?.matches(":last-child")) setUnwrapping(false); }}>
            {savedOnly && <section className="saved-collection">
              <h2>Your saved pieces</h2><p>{gift.savedSlots?.length ?? 0} saved · Kept here even when you replace a piece.</p>
              <ul>{gift.savedSlots?.map((slot) => <li key={slot.entity.id}>
                <div><span className="eyebrow">{singular[slot.kind]}</span><h3>{slot.entity.name}</h3>{slot.note && <p className="human-note">{slot.note}</p>}
                {slot.entity.destination && <a href={slot.entity.destination} target="_blank" rel="noopener noreferrer">Explore this pick ↗</a>}</div>
                <button disabled={!online || busy || mutating || !gift.receiptId} onClick={() => void action(slot.kind, "unsave", slot.entity.id)}>Remove from saved</button>
              </li>)}</ul>
            </section>}
            {!savedOnly && <GiftPanels
              slots={gift.slots}
              sender={gift.sender}
              recipient
              ordinals={gift.ordinals}
              invitation={(s) => s.kind === inviteKind && (
                <button className="known-invite" disabled={!online || busy || mutating} onClick={() => void action(s.kind, "known")}>
                  {s.kind === "movie" ? "Seen it already?" : s.kind === "book" ? "Read it already?" : "Know them already?"} <span>Ask for another {singular[s.kind]}</span>
                </button>
              )}
              actions={(s) => (
                <>
                  {gift.known?.includes(s.entity.id) && <p>Already known</p>}
                  {gift.declined?.includes(s.entity.id) && <p>Skipped</p>}
                  {!s.note && <p>Chosen as a replacement.</p>}
                  <button
                    className="action-save"
                    title={gift.saved?.includes(s.entity.id) ? "Remove from saved" : "Save in this browser"}
                    aria-pressed={gift.saved?.includes(s.entity.id) ?? false}
                    disabled={!online || busy || !gift.receiptId}
                    aria-disabled={mutating}
                    onClick={() =>
                      void action(
                        s.kind,
                        gift.saved?.includes(s.entity.id) ? "unsave" : "save",
                      )
                    }
                  >
                    {gift.saved?.includes(s.entity.id)
                      ? "Saved"
                      : "Save this"}
                  </button>
                  <div className="reaction-actions"><button
                    className="action-replace"
                    disabled={!online || busy || mutating || !gift.receiptId}
                    onClick={() => void action(s.kind, "known")}
                  >
                    Already know this
                  </button>
                  <button
                    className="action-decline"
                    disabled={!online || busy || mutating || !gift.receiptId}
                    onClick={() => void action(s.kind, "decline")}
                  >
                    Not for me
                  </button></div>
                  {gift.undoKind === s.kind && <button
                    className="action-undo"
                    disabled={!online || busy || mutating || !gift.receiptId}
                    onClick={() => void action(s.kind, "undo")}
                  >
                    Undo replacement
                  </button>}
                </>
              )}
            />}
          </div>
          <p className="fine-print">
            {sample ? "Your saves and skips stay in this browser. Nothing here is shared." : "Your saves and skips stay private. Return to them through this gift link."}
          </p>
          <button ref={savedToggle} onClick={() => setSavedOnly((v) => !v)}>
            {savedOnly ? "Show all pieces" : "Your saved pieces"}
          </button>
          {savedOnly &&
            !gift.savedSlots?.length && (
              <>
                <p>Nothing saved yet.</p>
                <p>Keep anything you want to come back to.</p>
              </>
            )}
          {sample && <section className="sample-next" aria-labelledby="sample-next-title">
            <p className="eyebrow">Your turn</p>
            <h2 id="sample-next-title">Send {gift.sender || "them"} <em>something back.</em></h2>
            <p>Mixtape starts a return gift with {gift.sender ? `${gift.sender}’s` : "their"} three pieces as the tastes to match. You add a few favourites of your own, and it picks from those.</p>
            <div className="sample-next-actions">
              <button className="primary" disabled={returnDisabled} onClick={() => void makeOneBack()}>Make one back</button>
              <button className="secondary" onClick={sample.onEdit}>Use this for a real friend</button>
            </div>
          </section>}

        </>
      )}
      {lastRepair && (
        <Sheet
          title={`Want another ${singular[lastRepair]}?`}
          open={!!repair}
          finalFocus={() => {
            const kind = focusSlot.current;
            return kind ? document.querySelector<HTMLElement>(`.panels > li[data-kind="${kind}"] article`) : true;
          }}
          onCloseComplete={() => {
            if (focusSlot.current) {
              document.querySelector<HTMLElement>(`.panels > li[data-kind="${focusSlot.current}"] article`)?.focus();
              focusSlot.current = null;
            }
          }}
          onOpenChange={(open) => {
            if (!open && !busy) setRepair(null);
          }}
        >
          <p>We will keep the other pieces.</p>
          {gift.repairEnabled && !gift.blockedRepairs?.includes(lastRepair) && !/did not return a choice/.test(error) && !error.startsWith("There is no other") && !/paused for now|New choices are unavailable|Qloo cannot use/.test(error) ? (
            <button className="primary" disabled={busy || !online || cooling || pending} onClick={() => void replace()}>
              Find another
            </button>
          ) : (
            <>
              {!gift.repairEnabled ? (
                <>
                  <p>
                    {gift.sender || "Your friend"} kept this mixtape as it is.
                  </p>
                  <button
                    disabled={busy || !online}
                    onClick={async () => {
                      try {
                        let next = gift;
                        for (const s of gift.slots.filter(
                          (s) =>
                            s.kind !== lastRepair &&
                            !gift.known?.includes(s.entity.id) &&
                            !gift.declined?.includes(s.entity.id),
                        )) {
                          next = await api<Gift>(
                            `/api/receipts/${gift.receiptId}/actions`,
                            "POST",
                            {
                              action: "save",
                              slotId: s.kind,
                              expectedVersion: next.version,
                            },
                          );
                        }
                        setGift(next);
                        setNotice("Saved in this browser.");
                        setRepair(null);
                      } catch (e) {
                        setError(message(e));
                      }
                    }}
                  >
                    Save the other pieces
                  </button>
                </>
              ) : (
                <p>Keep the other pieces, or make one back.</p>
              )}
            </>
          )}
          <button
            disabled={busy || !online || pending}
            onClick={async () => {
              if (await action(lastRepair, "undo")) setRepair(null);
            }}
          >
            Keep this piece
          </button>
          {(busy || events.length > 0) && <RunStatus key={startedAt} mode={gift.mode} events={events} busy={busy} startedAt={startedAt} onStop={() => { runController.current?.abort(); if (run) void api(`/api/runs/${run.id}/cancel`).catch((e) => setError(message(e))); }} />}
          {error && <p role="alert">{error}</p>}
          {resetAt && <p aria-live="off"><CooldownMessage resetAt={resetAt} /></p>}
          {latestButton}
        </Sheet>
      )}
      {!repair && busy && (
        <RunStatus
          key={startedAt}
          mode={gift.mode}
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
      {!repair && latestButton}
      {!repair && error && <p role="alert">{error}</p>}
      <p role="status">{notice}</p>
      {!sample && <p>Available until {expiryFormat.format(gift.expiresAt)}</p>}
    </div>
  );
}
