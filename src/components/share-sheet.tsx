"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type Ref } from "react";
import { current, eligibility, kinds, labels, type Draft } from "@/lib/domain-view";
import { api, message } from "@/lib/client";
import { Sheet } from "./ui/sheet";
import { useOnline } from "./network";
type LinkRecord = {
  id: string;
  token?: string;
  path: string | null;
  expiresAt: number;
};
export function ShareSheet({
  draft,
  onCreated,
  onBeforeOpen,
  onMissingNotes,
  disabled = false,
  triggerRef,
}: {
  draft: Draft;
  onCreated: () => Promise<void>;
  onBeforeOpen?: () => Promise<void>;
  onMissingNotes?: () => void;
  disabled?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false),
    [existingLinks, setExistingLinks] = useState<LinkRecord[]>([]),
    [revoking, setRevoking] = useState(false),
    [approved, setApproved] = useState(draft.shelf.map((e) => e.entity.id)),
    [repair, setRepair] = useState(true),
    [result, setResult] = useState<LinkRecord | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [copied, setCopied] = useState("");
  const online = useOnline();
  const linkField = useRef<HTMLInputElement>(null);
  const backToNotes = useRef(false);
  useEffect(() => { if (result?.path && open) linkField.current?.focus(); }, [result, open]);
  const slots = current(draft)?.slots ?? [];
  const missingNotes = slots.filter((s) => !s.note.trim()).length;
  const replacementPool = draft.categories.flatMap((kind) => eligibility(draft, kind))
    .filter((e) => !slots.some((s) => s.entity.id === e.entity.id));
  async function createLink() {
    setBusy(true);
    try {
      setResult(await api<LinkRecord>(`/api/drafts/${draft.id}/shares`, "POST", {
        expectedVersion: draft.version, idempotencyKey: key,
        repairEnabled: repair, approvedIds: approved,
      }));
      await onCreated();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return (
    <>
      <button
        className="primary"
        ref={triggerRef}
        disabled={!online || disabled || busy}
        onClick={async () => {
          if (missingNotes) { onMissingNotes?.(); return; }
          setBusy(true);
          try {
            await onBeforeOpen?.();
            setResult(null);
            setCopied("");
            setKey(crypto.randomUUID());
            setApproved(draft.shelf.map((e) => e.entity.id));
            setError("");
            setOpen(true);
            if (draft.shareIds.length) {
              const r = await api<{ links: LinkRecord[] }>(
                `/api/drafts/${draft.id}/shares`,
                "GET",
              );
              setExistingLinks(r.links);
            }
          } catch (e) {
            setError(message(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {missingNotes ? `Add ${missingNotes} ${missingNotes === 1 ? "note" : "notes"}` : "Create share link"}
      </button>
      <Sheet
        title={result ? `A little of your world, ready to send.` : `Ready for ${draft.recipient || "your friend"}?`}
        open={open}
        onOpenChange={setOpen}
        onCloseComplete={() => { if (backToNotes.current) { backToNotes.current = false; onMissingNotes?.(); } }}
        footer={!result ? <>{slots.some((s) => !s.note.trim()) && <div className="missing-note-help"><p>Add your own note to each piece before sharing.</p><button onClick={() => { backToNotes.current = true; setOpen(false); }}>Back to notes</button></div>}<button className="primary" disabled={busy || !online || slots.some((s) => !s.note.trim())} onClick={() => void createLink()}>{busy ? "Creating…" : "Create link"}</button></> : <button onClick={() => setOpen(false)}>Done</button>}
      >
        <p>
          Anyone with this link can open the mixtape. It will not show the rest
          of your shelf.
        </p>
        <p>
          It includes the tastes entered for them and why each piece was chosen.
        </p>
        {!result ? (
          <>
            <h3>Included in this mixtape</h3>
            <ul className="included-pieces">{slots.map((s) => <li key={s.kind}>{s.entity.name}<span>{labels[s.kind]}{!s.note.trim() ? " · Note needed" : ""}</span></li>)}</ul>
            {existingLinks.length > 0 && (
              <details className="existing-links">
                <summary>Previously shared links</summary>
                <ul>
                  {existingLinks.map((link) => (
                    <li key={link.id}>
                      <span>
                        Available until{" "}
                        {new Date(link.expiresAt).toLocaleDateString()}
                      </span>
                      <button onClick={() => setResult(link)}>
                        Manage this link
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <label>
              <input
                type="checkbox"
                checked={repair}
                onChange={(e) => setRepair(e.target.checked)}
              />
              Let them replace things they already know.
            </label>
            <p>
              Replacements come only from the favourites you approve here. A
              replacement without a note will say it is one of your favourites.
            </p>
            {repair && <details className="replacement-review"><summary>Review {replacementPool.length} approved replacements</summary><fieldset>
              <legend>Approved replacements</legend>
              {kinds.filter((kind) => draft.categories.includes(kind)).map((kind) => <div key={kind} className="replacement-category"><h4>{kind === "movie" ? "Films" : kind === "book" ? "Books" : "Artists"}</h4>{replacementPool.filter((e) => e.entity.kind === kind).map((e) => (
                <label key={e.entity.id}>
                  <input
                    type="checkbox"
                    checked={approved.includes(e.entity.id)}
                    onChange={(ev) =>
                      setApproved((v) =>
                        ev.target.checked
                          ? [...v, e.entity.id]
                          : v.filter((x) => x !== e.entity.id),
                      )
                    }
                  />
                  {e.entity.name}
                </label>
              ))}</div>)}
            </fieldset></details>}
            {error && <p role="alert">{error}</p>}
          </>
        ) : (
          <>
            <p role="status">{copied || "Your share link is ready."}</p>
            {result.path ? (
              <>
                <label htmlFor="share-link">Their link</label>
                <input
                  id="share-link"
                  ref={linkField}
                  readOnly
                  value={
                    typeof location === "undefined"
                      ? (result.path ?? "")
                      : location.origin + result.path
                  }
                />
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        location.origin + result.path,
                      );
                      setCopied("Link copied. Send it however you like.");
                    } catch {
                      setCopied(
                        "Copy did not work. Select and copy the link below.",
                      );
                    }
                  }}
                >
                  Copy link
                </button>
                <Link prefetch={false} href={result.path ?? "#"}>
                  Open as recipient
                </Link>
              </>
            ) : (
              <p>
                This link was replaced. Replace it again to get a new address.
              </p>
            )}
            <p>
              Available until {new Date(result.expiresAt).toLocaleDateString()}
            </p>
            <p className="fine-print">
              This link keeps the version you shared. Edits stay in your draft
              until you create a new link.
            </p>
            <button
              onClick={() => {
                setResult(null);
                setKey(crypto.randomUUID());
              }}
            >
              Create a new link
            </button>
            <details>
              <summary>Manage this link</summary>
              <p>
                Revoking stops future opens. It cannot remove copies someone has
                kept.
              </p>
              <button
                disabled={!online}
                onClick={async () => {
                  setError("");
                  setRevoking(true);
                }}
              >
                Revoke link
              </button>
              <button
                disabled={!online || busy}
                onClick={async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    const r = await api<{ token: string; expiresAt: number }>(
                      `/api/shares/${result.id}/rotate`,
                    );
                    setResult({ ...result, ...r, path: `/m/${r.token}` });
                  } catch (e) {
                    setError(message(e));
                  } finally { setBusy(false); }
                }}
              >
                Replace link
              </button>
            </details>
          </>
        )}
        {result && (
          <Sheet
            title="Stop this link from opening?"
            open={revoking}
            onOpenChange={(open) => { setError(""); setRevoking(open); }}
          >
            <p>Anyone using it will see that it is no longer available.</p>
            {error && <p role="alert">{error}</p>}
            <button
              className="primary"
              disabled={busy || !online}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api(`/api/shares/${result.id}`, "DELETE");
                  setExistingLinks((v) =>
                    v.filter((link) => link.id !== result.id),
                  );
                  setResult(null);
                  setKey(crypto.randomUUID());
                  setRevoking(false);
                  setError("This link has been revoked.");
                } catch (e) {
                  setError(message(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Revoke link
            </button>
            <button onClick={() => setRevoking(false)}>Keep link</button>
          </Sheet>
        )}
        {result && error && !revoking && <p role="alert">{error}</p>}
      </Sheet>
    </>
  );
}
