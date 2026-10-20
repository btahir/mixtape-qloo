"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import { samples } from "@/lib/samples";
import type { Draft } from "@/lib/domain";
import { agentRequest, api, message } from "@/lib/client";
import dynamic from "next/dynamic";
const Sheet = dynamic(() => import("./ui/sheet").then((m) => m.Sheet));
import { useOnline } from "./network";
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function Start({
  sampleId,
  label = "Make a mixtape",
  fixture = false,
  openGift = false,
}: {
  sampleId?: string;
  label?: string;
  fixture?: boolean;
  openGift?: boolean;
}) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const starting = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const online = useOnline();
  const [stage, setStage] = useState("Opening…");
  return (
    <>
      <button
        className={sampleId ? "primary" : "secondary"}
        disabled={!ready || busy || !online}
        onClick={async () => {
          if (starting.current) return;
          starting.current = true;
          setBusy(true);
          try {
            const d = await api<Draft>("/api/drafts", "POST", {
              source: sampleId ? fixture ? "fixture" : "sample" : "empty",
              sampleId,
            });
            if (openGift) {
              setStage("Choosing the three pieces…");
              try {
                const run = await agentRequest({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() }, (run) => {
                  try { sessionStorage.setItem(`mixtape-run:${d.id}`, run.id); } catch {}
                }, () => {});
                if (run.status === "ready") {
                  try { sessionStorage.removeItem(`mixtape-run:${d.id}`); } catch {}
                  router.push(`/make/${d.id}?opening=1`);
                  return;
                }
              } catch { /* The draft resumes or explains the failed run. */ }
            }
            router.push(`/make/${d.id}`);
          } catch (e) {
            setError(message(e));
          } finally {
            starting.current = false;
            setBusy(false);
          }
        }}
      >
        {!ready ? "Getting ready…" : busy ? stage : label}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function How({ comparisonHref }: { comparisonHref?: string }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [availableComparison, setAvailableComparison] = useState(comparisonHref);
  return (
    <>
      <button
        onClick={() => {
          setHasOpened(true);
          setOpen(true);
          void api<{ href?: string }>("/api/comparisons", "GET").then((value) => setAvailableComparison(value.href)).catch(() => {});
        }}
      >
        How it chooses
      </button>
      {hasOpened && (
        <Sheet
          title="Your shelf, their tastes"
          open={open}
          onOpenChange={setOpen}
        >
          <p>
            Qloo ranks your favourites using the things your friend likes,
            including connections between films, books and artists. The agent
            checks the choices and handles changes. Your words stay yours.
          </p>
          {availableComparison ? <Link prefetch={false} onClick={() => setOpen(false)} href={availableComparison}>See a comparison</Link> : <p>A comparison is not available yet.</p>}
        </Sheet>
      )}
    </>
  );
}
export function Samples() {
  return (
    <section className="sample-section" aria-label="Sample exchanges">
      <div className="section-heading">
        <h2>Start with a little inspiration.</h2>
        <span className="eyebrow">Three fictional exchanges</span>
      </div>
      <div className="sample-grid">
        {samples.map((s, i) => (
          <article key={s.id}>
            <span className="sample-number">0{i + 1}</span>
            <p className="eyebrow">
              {s.sender} → {s.recipient}
            </p>
            <h2>{s.title}</h2>
            <p>{s.tastes.join(" · ")}</p>
            <p>Fictional exchange</p>
            <Start sampleId={s.id} label="Try this exchange" />
          </article>
        ))}
      </div>
    </section>
  );
}
export function DraftList({ initial }: { initial: import("@/lib/server/repository").DraftSummary[] }) {
  const router = useRouter();
  const online = useOnline();
  const deletedFocus = useRef<HTMLElement | null>(null);
  const [drafts, setDrafts] = useState(initial),
    [deleting, setDeleting] = useState<import("@/lib/server/repository").DraftSummary | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <p>
        Your drafts stay in this browser. Clear its cookies and you may lose
        access.
      </p>
      <p>Drafts are kept for 30 days after your last edit.</p>
      {!drafts.length && (
        <>
          <h2>No drafts yet.</h2>
          <p>Start with a few things you love.</p>
          <Start />
        </>
      )}
      <ul className="draft-list">
        {drafts.map((d) => (
          <li key={d.id}>
            <Link prefetch={false} href={`/make/${d.id}`}>
              {d.recipient ? `For ${d.recipient}` : "Who is this for?"} ·
              Continue draft
            </Link>
            <button
              disabled={!online}
              onClick={() => {
                deletedFocus.current = null;
                setDeleting(d);
                setError("");
              }}
            >
              Delete draft
            </button>
            <button
              disabled={!online}
              onClick={async () => {
                try {
                  const next = await api<Draft>("/api/drafts", "POST", {
                    source: "repeat",
                    shareRef: d.id,
                  });
                  router.push(`/make/${next.id}`);
                } catch (e) {
                  setError(message(e));
                }
              }}
            >
              Make another for {d.recipient || "your friend"}
            </button>
          </li>
        ))}
      </ul>
      <Sheet
        title="Delete this draft and its shared links?"
        finalFocus={() => deletedFocus.current ?? true}
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null);
        }}
      >
        <p>This cannot be undone.</p>
        <button
          className="primary"
          disabled={pending || !online}
          onClick={async () => {
            if (!deleting) return;
            setPending(true);
            try {
              await api(`/api/drafts/${deleting.id}`, "DELETE", {
                expectedVersion: deleting.version,
              });
              const rows = Array.from(document.querySelectorAll<HTMLElement>(".draft-list > li"));
              const index = drafts.findIndex((d) => d.id === deleting.id);
              deletedFocus.current = (rows[index + 1] ?? rows[index - 1])?.querySelector<HTMLElement>("a") ?? document.querySelector<HTMLElement>(".site-header .wordmark");
              setDrafts((v) => v.filter((x) => x.id !== deleting.id));
              setDeleting(null);
            } catch {
              setError("The draft was not deleted. Try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          Delete draft
        </button>
        <button disabled={pending} onClick={() => setDeleting(null)}>
          Keep draft
        </button>
        {error && <p role="alert">{error}</p>}
      </Sheet>
      {error && !deleting && <p role="alert">{error}</p>}
    </>
  );
}
