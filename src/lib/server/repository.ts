import "server-only";
import { z } from "zod";
import {
  draftSchema,
  shareSchema,
  receiptSchema,
  type Draft,
  type Share,
  type Receipt,
  current,
  giftProjection,
  eligibility,
  kindSchema,
  entitySchema,
  replacementIndex,
} from "../domain";
import { selectionShelfFingerprint } from "../agent/tools";
import { liveSample } from "./sample-manifest";
import { sampleDraft } from "../samples";
import { read, put, update, MONTH, store, type Write } from "./store";
import { opaque, hash, sign } from "./security";
import { AppError, conflict, gone, unavailable } from "./errors";
export const draftSummarySchema = draftSchema.pick({ id: true, sender: true, recipient: true, version: true, updatedAt: true, expiresAt: true }).strip();
export type DraftSummary = z.infer<typeof draftSummarySchema>;
export const indexSchema = z.object({ ids: z.array(z.string()).max(100), summaries: z.record(z.string(), draftSummarySchema).optional() });
const profileSchema = z.object({ shared: z.array(z.string()).max(100) });
const profileKey = (d: Draft) => `profile:${d.owner}:${d.profileId ?? d.id}`;
/** Renew discovery and publication history with the activity that keeps a draft alive. */
export async function activityWrites(d: Draft): Promise<Write[]> {
  const key = `index:${d.owner}`, raw = await store().get(key);
  const index = raw ? indexSchema.parse(JSON.parse(raw)) : { ids: [], summaries: {} };
  const ids = index.ids.filter((id) => !index.summaries?.[id] || index.summaries[id].expiresAt > Date.now());
  if (!ids.includes(d.id) && ids.length >= 100) throw new AppError(400, "This browser has 100 drafts. Delete a draft from My drafts before starting another.");
  const summaries = Object.fromEntries(ids.filter((id) => id !== d.id && index.summaries?.[id]).map((id) => [id, index.summaries![id]]));
  const nextIds = d.deleted ? ids.filter((id) => id !== d.id) : [d.id, ...ids.filter((id) => id !== d.id)];
  if (!d.deleted) summaries[d.id] = draftSummarySchema.parse(d);
  const writes: Write[] = [{ key, old: raw, value: JSON.stringify({ ids: nextIds, summaries }), ttlMs: MONTH }];
  const history = await store().get(profileKey(d));
  if (history) writes.push({ key: profileKey(d), old: history, value: history, ttlMs: MONTH });
  return writes;
}
function withTasteState(d: Draft): Draft {
  const r = current(d);
  if (!r) return d;
  const signals = JSON.stringify(d.tastes.map((e) => e.id));
  return {
    ...d,
    revisions: [
      ...d.revisions.slice(0, -1),
      {
        ...r,
        slots: r.slots.map((slot) => ({
          ...slot,
          previousShelf: !!slot.evidence.shelfFingerprint && slot.evidence.shelfFingerprint !== selectionShelfFingerprint(d, slot.kind),
          previousTastes:
            JSON.stringify(slot.evidence.signals.map((e) => e.id)) !== signals,
        })),
      },
    ],
  };
}
export async function owned(id: string, owner: string) {
  const d = await read(`draft:${id}`, draftSchema);
  if (!d || d.deleted || d.owner !== owner || d.expiresAt < Date.now())
    throw new AppError(403, "This browser cannot edit that draft.");
  const history = await read(profileKey(d), profileSchema);
  return withTasteState({ ...d, shared: [...new Set([...d.shared, ...(history?.shared ?? [])])] });
}
export async function listDrafts(owner: string, limit = 100): Promise<DraftSummary[]> {
  const index = await read(`index:${owner}`, indexSchema);
  const ids = (index?.ids ?? []).filter((id) => !index?.summaries?.[id] || index.summaries[id].expiresAt > Date.now()).slice(0, limit);
  const drafts = await Promise.all(ids.map(async (id) => {
    if (index?.summaries?.[id]) return index.summaries[id];
    // Compatibility for drafts created before the compact index was introduced.
    try { return draftSummarySchema.parse(await owned(id, owner)); }
    catch (error) { if (!(error instanceof AppError) || error.status !== 403) throw error; return null; }
  }));
  return drafts.filter((d): d is DraftSummary => d !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function createDraft(
  owner: string,
  source: "empty" | "sample" | "fixture" | "return" | "repeat",
  sampleId?: string,
  shareRef?: string,
  receiptRef?: string,
) {
  if ((source === "empty" || source === "sample") && process.env.QLOO_MODE === "live" && !process.env.QLOO_API_KEY)
    throw new AppError(503, "We cannot reach Qloo with this setup.");
  let d: Draft = {
    id: opaque(),
    owner,
    mode: process.env.QLOO_API_KEY && process.env.QLOO_MODE !== "fixture" ? "live" : "fixture",
    sender: "",
    recipient: "",
    introduction: "",
    shelf: [],
    tastes: [],
    declaredBy: "sender",
    categories: ["movie", "book", "artist"],
    known: [],
    shared: [],
    excluded: [],
    revisions: [],
    version: 0,
    shareIds: [],
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + MONTH,
    deleted: false,
  };
  if (source === "sample" || source === "fixture") {
    if (!sampleId) throw new AppError(400, "Choose a sample.");
    d = { ...d, ...sampleDraft(sampleId, owner) };
    const verified = source === "fixture" ? null : await liveSample(sampleId, owner);
    if (verified) d = { ...d, ...verified, mode: "live" };
    else if (source === "sample" && process.env.QLOO_API_KEY && process.env.QLOO_MODE !== "fixture")
      throw new AppError(503, "This live exchange is not ready yet. Open an illustrative sample, or start with your own favourites.");
  }
  if (source === "return") {
    if (!shareRef && !receiptRef) throw gone();
    // A private sample receipt returns through its owner's receipt, never a link.
    const s = receiptRef ? (await ownedReceipt(receiptRef, owner)).s : await publicShare(shareRef!);
    d = {
      ...d,
      mode: s.mode,
      sampleId: s.sampleId,
      sender: s.recipient,
      recipient: s.sender,
      tastes: s.revision.slots.map((x) => x.entity),
      returnCandidates: s.tastes,
    };
  }
  if (source === "repeat") {
    if (!shareRef) throw new AppError(400, "Choose a draft.");
    const prev = await owned(shareRef, owner);
    d = {
      ...d,
      mode: prev.mode,
      sampleId: prev.sampleId,
      sender: prev.sender,
      recipient: prev.recipient,
      shelf: prev.shelf,
      tastes: prev.tastes,
      profileId: prev.profileId ?? prev.id,
      shared: prev.shared,
      categories: prev.categories,
    };
  }
  d.profileId ??= d.id;
  if (!(await store().batchCas([
    { key: `draft:${d.id}`, old: null, value: JSON.stringify(draftSchema.parse(d)), ttlMs: MONTH },
    ...await activityWrites(d),
  ]))) throw conflict();
  return d;
}
export const patchSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    sender: z.string().trim().max(40).optional(),
    recipient: z.string().trim().max(40).optional(),
    introduction: z.string().trim().max(240).optional(),
    categories: z
      .array(kindSchema)
      .min(2)
      .max(3)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    notes: z.record(z.string(), z.string().trim().max(240)).optional(),
    remove: z
      .object({ list: z.enum(["shelf", "tastes"]), id: z.string() })
      .strict()
      .optional(),
    lock: z
      .object({ kind: kindSchema, locked: z.boolean() })
      .strict()
      .optional(),
    confirmReturnFavourites: z.union([z.boolean(), z.array(z.string()).max(5)]).optional(),
    skipReturnFavourites: z.boolean().optional(),
  })
  .strict();
export async function mutateDraft(
  id: string,
  owner: string,
  expected: number,
  fn: (d: Draft) => Draft,
) {
  const visible = await owned(id, owner);
  for (let attempt = 0; attempt < 40; attempt++) {
    const raw = await store().get(`draft:${id}`);
    const d = raw ? draftSchema.parse(JSON.parse(raw)) : null;
    if (!d || d.deleted || d.owner !== owner) throw new AppError(403, "This browser cannot edit that draft.");
    if (d.version !== expected) throw conflict();
    const next = draftSchema.parse({ ...fn({ ...d, shared: visible.shared }), version: d.version + 1,
      updatedAt: new Date().toISOString(), expiresAt: Date.now() + MONTH });
    if (await store().batchCas([
      ...await activityWrites(next),
      { key: `draft:${id}`, old: raw, value: JSON.stringify(next), ttlMs: MONTH },
    ])) return withTasteState(next);
  }
  throw conflict();
}
export async function saveDraft(
  id: string,
  owner: string,
  p: z.infer<typeof patchSchema>,
) {
  return mutateDraft(id, owner, p.expectedVersion, (d) => {
    const {
      expectedVersion: _,
      notes,
      remove,
      lock,
      confirmReturnFavourites,
      skipReturnFavourites,
      ...fields
    } = p;
    void _;
    Object.assign(d, fields);
    if (notes) {
      for (const key of Object.keys(notes))
        if (!d.shelf.some((e) => e.entity.id === key))
          throw new AppError(
            400,
            "The note must belong to a confirmed favourite.",
          );
      d.shelf = d.shelf.map((e) => ({
        ...e,
        note: notes[e.entity.id] ?? e.note,
        ...(notes[e.entity.id] !== undefined && notes[e.entity.id] !== e.note
          ? {
              noteAuthor: "human" as const,
              noteAuthoredAt: new Date().toISOString(),
            }
          : {}),
      }));
    }
    if (remove) {
      if (remove.list === "shelf")
        d.shelf = d.shelf.filter((e) => e.entity.id !== remove.id);
      else d.tastes = d.tastes.filter((e) => e.id !== remove.id);
    }
    if (confirmReturnFavourites && d.returnCandidates) {
      const selected = Array.isArray(confirmReturnFavourites) ? confirmReturnFavourites : d.returnCandidates.map((e) => e.id);
      if (new Set(selected).size !== selected.length || selected.some((id) => !d.returnCandidates!.some((e) => e.id === id)))
        throw new AppError(400, "Confirm only the favourites shown here.");
      for (const e of d.returnCandidates.filter((e) => selected.includes(e.id))) {
        if (!d.shelf.some((x) => x.entity.id === e.id) && d.shelf.length < 12)
          d.shelf.push({
            entity: e,
            note: "",
            confirmedFavourite: true,
            confirmedBySession: owner,
          });
      }
      delete d.returnCandidates;
    }
    if (skipReturnFavourites) delete d.returnCandidates;
    const r = current(d);
    if (r) {
      const next = structuredClone(r);
      delete next.replacementKind;
      next.id = opaque();
      next.createdAt = new Date().toISOString();
      next.slots = next.slots.map((s) => ({
        ...s,
        note: notes?.[s.entity.id] ?? s.note,
        ...(lock?.kind === s.kind
          ? {
              locked: lock.locked,
              method: lock.locked
                ? ("human_lock" as const)
                : s.evidence.mode === "fixture"
                  ? ("illustrative" as const)
                  : ("qloo" as const),
            }
          : {}),
      }));
      next.slots = next.slots.map((slot) => ({
        ...slot,
        previousTastes:
          JSON.stringify(slot.evidence.signals.map((e) => e.id)) !==
          JSON.stringify(d.tastes.map((e) => e.id)),
      }));
      if (JSON.stringify(next.slots) !== JSON.stringify(r.slots)) {
        d.revisions.push(next);
        d.revisions = d.revisions.slice(-30);
      }
    }
    return d;
  });
}
export async function deleteDraft(id: string, owner: string, version: number) {
  const existing = await read(`draft:${id}`, draftSchema);
  if (!existing || existing.owner !== owner) throw new AppError(403, "This browser cannot edit that draft.");
  const d = existing.deleted ? existing : await mutateDraft(id, owner, version, (draft) => ({ ...draft, deleted: true }));
  // The tombstone immediately blocks public access and stays owner-retryable.
  // Expired dependencies need no write; CAS never recreates a vanished share.
  for (const sid of d.shareIds) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const raw = await store().get(`share:${sid}`);
      if (!raw) break;
      const share = shareSchema.parse(JSON.parse(raw));
      if (await store().cas(`share:${sid}`, raw, JSON.stringify({ ...share, revoked: true, tokenHashes: [] }), Math.max(1, share.expiresAt - Date.now()))) break;
      if (attempt === 39) throw conflict();
    }
  }
  await update(`index:${owner}`, indexSchema, (index) => ({ ids: (index?.ids ?? []).filter((draftId) => draftId !== id), summaries: Object.fromEntries(Object.entries(index?.summaries ?? {}).filter(([key]) => key !== id)) }), MONTH);
  // Keep only an empty capability tombstone so acknowledgement can be retried.
  await update(`draft:${id}`, draftSchema, (draft) => {
    if (!draft || draft.owner !== owner || !draft.deleted) throw conflict();
    return { ...draft, sender: "", recipient: "", introduction: "", shelf: [], tastes: [], revisions: [], shareIds: [], known: [], excluded: [], shared: [], returnCandidates: undefined };
  }, MONTH);
  return { deleted: true };
}
export async function undoDraft(id: string, owner: string, version: number) {
  return mutateDraft(id, owner, version, (d) => {
    const index = replacementIndex(d.revisions);
    if (index < 1)
      throw new AppError(400, "There is no replacement to undo.");
    const kind = d.revisions[index].replacementKind!;
    const previous = d.revisions[index - 1];
    const latest = current(d)!;
    d.excluded = [...previous.excluded];
    const restored = {
      ...previous,
      id: opaque(),
      createdAt: new Date().toISOString(),
      replacementKind: undefined,
      slots: latest.slots.map((slot) => {
        const selected = slot.kind === kind
          ? previous.slots.find((s) => s.kind === kind)!
          : slot;
        return { ...selected, note: d.shelf.find((e) => e.entity.id === selected.entity.id)?.note ?? selected.note };
      }),
    };
    d.revisions = [...d.revisions.slice(0, index), restored];
    return d;
  });
}
export const searchRefSchema = z.object({
  owner: z.string(),
  entity: entitySchema,
  expiresAt: z.number(),
});
export async function confirmEntity(
  id: string,
  owner: string,
  expected: number,
  ref: string,
  list: "shelf" | "tastes",
) {
  const r = await read(`search:${ref}`, searchRefSchema);
  if (!r || r.owner !== owner || r.expiresAt < Date.now())
    throw new AppError(400, "Search again to confirm this identity.");
  return mutateDraft(id, owner, expected, (d) => {
    if (r.entity.mode !== d.mode)
      throw new AppError(400, "Sample and live choices cannot be mixed.");
    const entries = list === "shelf" ? d.shelf.map((e) => e.entity) : d.tastes;
    if (entries.some((e) => e.id === r.entity.id))
      throw new AppError(400, "That is already on this list.");
    if (entries.length >= (list === "shelf" ? 12 : 5))
      throw new AppError(
        400,
        list === "shelf"
          ? "Your shelf is full. Remove one to add another."
          : "Remove a taste to add another.",
      );
    if (list === "shelf")
      d.shelf.push({
        entity: r.entity,
        note: "",
        confirmedFavourite: true,
        confirmedBySession: owner,
      });
    else d.tastes.push(r.entity);
    return d;
  });
}
export const shareInput = z
  .object({
    expectedVersion: z.number().int(),
    idempotencyKey: z.string().min(8).max(100),
    repairEnabled: z.boolean(),
    approvedIds: z.array(z.string()).max(12),
  })
  .strict();
function shareToken(id: string, key: string) {
  return sign(`share:${id}:${key}`);
}
export async function publishedPieces(d: Draft) {
  const prior = await Promise.all(d.shareIds.map((sid) => read(`share:${sid}`, shareSchema)));
  return new Set(prior.flatMap((s) => s?.owner === d.owner && s.draftId === d.id ? s.revision.slots.map((x) => x.entity.id) : []));
}
export async function createShare(
  id: string,
  owner: string,
  p: z.infer<typeof shareInput>,
) {
  const d = await owned(id, owner);
  const inputHash = hash(JSON.stringify(p));
  for (const sid of d.shareIds) {
    const old = await read(`share:${sid}`, shareSchema);
    if (old?.idempotencyKey === p.idempotencyKey) {
      if (old.inputHash !== inputHash) throw conflict();
      const token = shareToken(old.id, p.idempotencyKey);
      if (old.revoked || !old.tokenHashes.includes(hash(token)))
        throw new AppError(409, "This link changed. Create a new link.");
      return { share: old, token };
    }
  }
  if (d.version !== p.expectedVersion) throw conflict();
  const r = current(d);
  if (!r || r.slots.length !== d.categories.length ||
      r.slots.some((s, i) => s.kind !== d.categories[i]))
    throw new AppError(400, "Make their mixtape first.");
  if (r.slots.some((s) => !s.note.trim()))
    throw new AppError(400, "Add your own note to each piece before sharing.");
  if (
    r.slots.some(
      (s) =>
        ((s.previousTastes || s.previousShelf) && !s.locked) ||
        !d.shelf.some((e) => e.entity.id === s.entity.id) ||
        d.tastes.some((e) => e.id === s.entity.id) ||
        d.known.includes(s.entity.id) ||
        d.excluded.includes(s.entity.id),
    )
  )
    throw new AppError(
      400,
      "Update their mixtape before sharing these choices.",
    );
  // A replacement link may carry unchanged pieces from this gift's own lineage.
  // Publication history from a different exchange remains a hard exclusion.
  const carried = await publishedPieces(d);
  if (r.slots.some((s) => d.shared.includes(s.entity.id) && !carried.has(s.entity.id)))
    throw new AppError(400, "Update their mixtape before sharing these choices.");
  const historyKey = profileKey(d), historyRaw = await store().get(historyKey);
  const history = historyRaw ? profileSchema.parse(JSON.parse(historyRaw)).shared : [];
  if (r.slots.some((s) => history.includes(s.entity.id) && !carried.has(s.entity.id)))
    throw new AppError(400, "Update their mixtape before sharing these choices.");
  if (p.approvedIds.some((id) => !d.shelf.some((e) => e.entity.id === id)))
    throw new AppError(400, "Approve favourites from your shelf.");
  const pool = d.shelf.filter(
    (e) =>
      p.approvedIds.includes(e.entity.id) &&
      !d.tastes.some((t) => t.id === e.entity.id) &&
      !d.known.includes(e.entity.id) &&
      !d.shared.includes(e.entity.id) &&
      !history.includes(e.entity.id) &&
      !d.excluded.includes(e.entity.id),
  );
  if (
    p.repairEnabled &&
    !pool.some((e) => !r.slots.some((s) => s.entity.id === e.entity.id))
  )
    throw new AppError(400, "There are no replacements on this shelf yet.");
  const sid = opaque(),
    token = shareToken(sid, p.idempotencyKey);
  const s: Share = {
    id: sid,
    owner,
    draftId: id,
    tokenHashes: [hash(token)],
    generation: 0,
    mode: d.mode,
    sampleId: d.sampleId,
    sender: d.sender,
    recipient: d.recipient,
    introduction: d.introduction,
    tastes: d.tastes,
    revision: structuredClone(r),
    pool,
    repairEnabled: p.repairEnabled,
    revoked: false,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + MONTH,
    idempotencyKey: p.idempotencyKey,
    inputHash,
  };
  const original = await store().get(`draft:${id}`);
  if (
    !original ||
    draftSchema.parse(JSON.parse(original)).version !== d.version
  )
    throw conflict();
  const next = draftSchema.parse({
    ...d,
    version: d.version + 1,
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + MONTH,
    shareIds: [...d.shareIds, sid],
    shared: [...new Set([...d.shared, ...history, ...r.slots.map((s) => s.entity.id)])],
  });
  if (
    !(await store().batchCas([
      {
        key: `draft:${id}`,
        old: original,
        value: JSON.stringify(next),
        ttlMs: MONTH,
      },
      ...((await activityWrites(next)).filter((w) => w.key !== historyKey)),
      { key: historyKey, old: historyRaw, value: JSON.stringify(profileSchema.parse({ shared: next.shared })), ttlMs: MONTH },
      {
        key: `share:${sid}`,
        old: null,
        value: JSON.stringify(shareSchema.parse(s)),
        ttlMs: MONTH,
      },
      {
        key: `token:${hash(token)}`,
        old: null,
        value: JSON.stringify(sid),
        ttlMs: MONTH,
      },
    ]).catch(() => { throw new AppError(503, "The link was not created. Your draft is still here."); }))
  )
    throw conflict();
  return { share: s, token };
}
/** Owner-only link management projection; never includes the private repair pool. */
export async function ownedLinks(id: string, owner: string) {
  const d = await owned(id, owner);
  const links = await Promise.all(
    d.shareIds.map(async (sid) => {
      const s = await read(`share:${sid}`, shareSchema);
      if (!s || s.owner !== owner || s.revoked || s.expiresAt <= Date.now())
        return null;
      const token = shareToken(s.id, s.rotationNonce ?? s.idempotencyKey);
      // Derive the current bearer token only for its owner; public lookup stays hashed.
      return {
        id: s.id,
        path: s.tokenHashes.includes(hash(token)) ? `/m/${token}` : null,
        expiresAt: s.expiresAt,
      };
    }),
  );
  return links.filter((link) => link !== null).reverse();
}
export async function activeShare(sid: string) {
  const s = await read(`share:${sid}`, shareSchema);
  if (!s || s.revoked || s.expiresAt < Date.now()) throw gone();
  const d = await read(`draft:${s.draftId}`, draftSchema);
  if (d?.deleted) throw gone();
  return s;
}
export async function publicShare(token: string) {
  const sid = await read(`token:${hash(token)}`, z.string());
  if (!sid) throw gone();
  const s = await activeShare(sid);
  if (!s.tokenHashes.includes(hash(token))) throw gone();
  return s;
}
export async function manageShare(sid: string, owner: string, rotate = false) {
  const s = await activeShare(sid);
  if (s.owner !== owner)
    throw new AppError(403, "This browser cannot manage that link.");
  const nonce = rotate ? opaque() : undefined;
  const token = nonce ? shareToken(sid, nonce) : "";
  const raw = await store().get(`share:${sid}`);
  if (!raw) throw gone();
  const old = shareSchema.parse(JSON.parse(raw));
  if (old.revoked || old.owner !== owner) throw gone();
  const next = shareSchema.parse({
    ...old,
    revoked: !rotate,
    generation: old.generation + 1,
    rotationNonce: nonce,
    tokenHashes: rotate ? [hash(token)] : [],
  });
  const ttl = old.expiresAt - Date.now();
  if (
    !(await store().batchCas([
      {
        key: `share:${sid}`,
        old: raw,
        value: JSON.stringify(next),
        ttlMs: ttl,
      },
      ...(rotate
        ? [
            {
              key: `token:${hash(token)}`,
              old: null,
              value: JSON.stringify(sid),
              ttlMs: ttl,
            },
          ]
        : []),
    ]))
  )
    throw conflict();
  return rotate ? { token, expiresAt: s.expiresAt } : { revoked: true };
}
export const receiptIndexKey = (owner: string, s: Share) => `receipt-index:${owner}:${s.id}${s.generation ? `:${s.generation}` : ""}`;
export async function existingGift(s: Share, owner?: string) {
  const rid = owner ? await read(receiptIndexKey(owner, s), z.string()) : null;
  const receipt = rid && owner ? await ownedReceipt(rid, owner) : null;
  return giftProjection(s, receipt?.r);
}
export async function openReceipt(token: string, owner: string) {
  try { return await allocateReceipt(token, owner); }
  catch (error) {
    if (!(error instanceof AppError) || error.status !== 503) throw error;
    return giftProjection(await publicShare(token));
  }
}
async function allocateReceipt(token: string, owner: string) {
  return allocateFor(await publicShare(token), owner);
}
const sampleShareSchema = z.object({ shareId: z.string(), revisionId: z.string() }).strict();
/**
 * A private receiving session for a fictional sample. It is a share record with no
 * bearer token, so no link can open it, and it never enters the draft's publication
 * history. Repairs run through the same receipt, exclusion and ranking path as a link.
 */
export async function sampleReceipt(draftId: string, owner: string) {
  const d = await owned(draftId, owner);
  const r = current(d);
  if (!d.sampleId) throw new AppError(400, "Only a sample gift opens here.");
  if (!r || r.slots.length !== d.categories.length || r.slots.some((s, i) => s.kind !== d.categories[i]) ||
      r.slots.some((s) => (s.previousTastes || s.previousShelf) && !s.locked))
    throw new AppError(400, "Make their mixtape first.");
  const key = `sample-share:${owner}:${d.id}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await store().get(key);
    const pointer = raw ? sampleShareSchema.parse(JSON.parse(raw)) : null;
    const existing = pointer?.revisionId === r.id ? await read(`share:${pointer.shareId}`, shareSchema) : null;
    if (existing && !existing.revoked && existing.expiresAt > Date.now()) return allocateFor(existing, owner);
    const pool = d.shelf.filter((e) =>
      !d.tastes.some((t) => t.id === e.entity.id) && !d.known.includes(e.entity.id) && !d.excluded.includes(e.entity.id));
    const s: Share = {
      id: opaque(),
      owner,
      draftId: d.id,
      tokenHashes: [],
      generation: 0,
      mode: d.mode,
      sampleId: d.sampleId,
      sender: d.sender,
      recipient: d.recipient,
      introduction: d.introduction,
      tastes: d.tastes,
      revision: structuredClone(r),
      pool,
      repairEnabled: pool.some((e) => !r.slots.some((x) => x.entity.id === e.entity.id)),
      revoked: false,
      createdAt: new Date().toISOString(),
      expiresAt: Math.min(d.expiresAt, Date.now() + MONTH),
      idempotencyKey: `sample:${r.id}`,
      inputHash: hash(`sample:${d.id}:${r.id}`),
    };
    const ttlMs = s.expiresAt - Date.now();
    if (await store().batchCas([
      { key: `share:${s.id}`, old: null, value: JSON.stringify(shareSchema.parse(s)), ttlMs },
      { key, old: raw, value: JSON.stringify({ shareId: s.id, revisionId: r.id }), ttlMs },
    ])) return allocateFor(s, owner);
  }
  throw conflict();
}
async function allocateFor(s: Share, owner: string) {
  const key = receiptIndexKey(owner, s);
  const rid = await update(
    key,
    z.string(),
    (old) => old ?? opaque(),
    s.expiresAt - Date.now(),
  );
  let r = await read(`receipt:${rid}`, receiptSchema);
  if (!r) {
    r = {
      id: rid,
      owner,
      shareId: s.id,
      generation: s.generation,
      blockedRepairs: [],
      version: 0,
      revisions: [s.revision],
      known: [],
      declined: [],
      saved: [],
      savedSlots: [],
      shown: s.revision.slots.map((x) => x.entity.id),
      expiresAt: s.expiresAt,
    };
    try {
      await put(`receipt:${rid}`, receiptSchema, r, s.expiresAt - Date.now());
    } catch {
      r = await read(`receipt:${rid}`, receiptSchema);
      if (!r) throw unavailable();
    }
  }
  return giftProjection(s, r);
}
export async function ownedReceipt(id: string, owner: string) {
  const r = await read(`receipt:${id}`, receiptSchema);
  if (!r || r.owner !== owner || r.expiresAt < Date.now()) throw gone();
  const s = await activeShare(r.shareId);
  if (s.generation !== r.generation) throw gone();
  return { r, s };
}
export async function mutateReceipt(
  id: string,
  owner: string,
  version: number,
  fn: (r: Receipt) => Receipt,
) {
  const { s } = await ownedReceipt(id, owner);
  const [raw, shareRaw] = await Promise.all([store().get(`receipt:${id}`), store().get(`share:${s.id}`)]);
  if (!raw || !shareRaw) throw gone();
  const r = receiptSchema.parse(JSON.parse(raw)), latestShare = shareSchema.parse(JSON.parse(shareRaw));
  if (r.owner !== owner || r.generation !== latestShare.generation || latestShare.revoked || latestShare.expiresAt <= Date.now()) throw gone();
  if (r.version !== version) throw conflict();
  const next = receiptSchema.parse({ ...fn(r), version: version + 1 });
  if (!(await store().batchCas([
    { key: `share:${s.id}`, old: shareRaw, value: shareRaw, ttlMs: latestShare.expiresAt - Date.now() },
    { key: `receipt:${id}`, old: raw, value: JSON.stringify(next), ttlMs: next.expiresAt - Date.now() },
  ]))) throw conflict();
  return giftProjection(latestShare, next);
}
export async function receiptAction(
  id: string,
  owner: string,
  p: {
    action: "save" | "unsave" | "known" | "decline" | "undo";
    slotId: typeof kindSchema._output;
    savedEntityId?: string;
    expectedVersion: number;
  },
) {
  return mutateReceipt(id, owner, p.expectedVersion, (r) => {
    const slot = current(r)?.slots.find((s) => s.kind === p.slotId);
    if (!slot) throw gone();
    if (p.savedEntityId && (p.action !== "unsave" || !r.saved.includes(p.savedEntityId))) throw gone();
    const id = p.savedEntityId ?? slot.entity.id;
    if (p.action === "save") {
      r.saved = [...new Set([...r.saved, id])];
      if (!r.savedSlots.some((saved) => saved.entity.id === id)) r.savedSlots.push(structuredClone(slot));
    }
    if (p.action === "unsave") {
      r.saved = r.saved.filter((x) => x !== id);
      r.savedSlots = r.savedSlots.filter((saved) => saved.entity.id !== id);
    }
    if (p.action === "known" || p.action === "decline") {
      const field = p.action === "known" ? "known" : "declined";
      r[field] = [...new Set([...r[field], id])];
      r.lastReaction = { kind: p.slotId, id, action: p.action };
    }
    if (p.action === "undo") {
      if (r.lastReaction) {
        if (r.lastReaction.kind !== p.slotId) throw new AppError(400, "Keep or replace the piece you just marked.");
        const field = r.lastReaction.action === "known" ? "known" : "declined";
        r[field] = r[field].filter((x) => x !== r.lastReaction?.id);
      } else {
        const index = replacementIndex(r.revisions);
        if (index < 1 || r.revisions[index].replacementKind !== p.slotId)
          throw new AppError(400, "There is no replacement to undo for this piece.");
        r.revisions = r.revisions.slice(0, index);
      }
      delete r.lastReaction;
    }
    return r;
  });
}
export function repairDraft(s: Share, r: Receipt): Draft {
  return {
    id: r.id,
    owner: r.owner,
    mode: s.mode,
    sampleId: s.sampleId,
    sender: s.sender,
    recipient: s.recipient,
    introduction: s.introduction,
    shelf: s.pool,
    tastes: s.tastes,
    declaredBy: "sender",
    categories: s.revision.slots.map((x) => x.kind),
    known: [...r.known, ...r.declined],
    shared: [],
    excluded: r.shown,
    revisions: r.revisions,
    version: r.version,
    shareIds: [],
    updatedAt: new Date().toISOString(),
    expiresAt: r.expiresAt,
    deleted: false,
  };
}
export function approvedPool(d: Draft) {
  return d.categories.flatMap((k) => eligibility(d, k));
}
