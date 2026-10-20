import { z } from "zod";
import { kinds, singular, eligibility, current, replacementIndex } from "./domain-view";
export { kinds, labels, singular, entityDetail, eligibility, current, replacementIndex } from "./domain-view";
export const kindSchema = z.enum(kinds);
export type Kind = z.infer<typeof kindSchema>;
export const modeSchema = z.enum(["live", "fixture"]);
export const entitySchema = z
  .object({
    id: z.string().max(100).transform((id) => /^[0-9a-f-]{36}$/i.test(id) ? id.toUpperCase() : id),
    kind: kindSchema,
    name: z.string().min(1).max(200),
    detail: z.string().max(400).default("Details unavailable"),
    description: z.string().max(1200).optional(),
    imageUrl: z.url({ protocol: /^https$/ }).max(2048).optional(),
    imageAttribution: z.string().max(200).optional(),
    destination: z.url({ protocol: /^https$/ }).max(2048).optional(),
    mode: modeSchema,
    fetchedAt: z.string(),
  })
  .strict();
export type Entity = z.infer<typeof entitySchema>;
export const entrySchema = z
  .object({
    entity: entitySchema,
    note: z.string().trim().max(240),
    confirmedFavourite: z.literal(true),
    confirmedBySession: z.string(),
    noteAuthor: z.enum(["human", "fictional_editor"]).optional(),
    noteAuthoredAt: z.string().optional(),
  })
  .strict();
export const evidenceSchema = z
  .object({
    mode: modeSchema,
    category: kindSchema,
    signals: z.array(entitySchema).max(5),
    fingerprint: z.string(),
    shelfFingerprint: z.string().optional(),
    eligibleCount: z.number().int(),
    returnedCount: z.number().int(),
    missingCount: z.number().int(),
    rejectedCount: z.number().int(),
    rank: z.number().int(),
    selectedId: z.string(),
    score: z.number().min(0).max(1).nullable(),
    fetchedAt: z.string().nullable(),
    cache: z.enum(["hit", "miss", "illustrative"]),
    schema: z.string(),
    warnings: z.array(z.string().max(160)).max(8),
    explanationStatus: z
      .enum(["unavailable", "unverified", "failed", "verified"])
      .default("unavailable"),
    highlightedSignalId: z.string().optional(),
    interpretation: z.string().min(1).max(180).optional(),
    readingDetail: z.string().max(100).optional(),
    contributions: z.array(z.object({ entityId: z.string(), score: z.number().min(0).max(1) })).max(5).optional(),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const slotSchema = z
  .object({
    kind: kindSchema,
    entity: entitySchema,
    note: z.string().max(240),
    locked: z.boolean(),
    method: z.enum(["qloo", "human_lock", "illustrative"]),
    evidence: evidenceSchema,
    previousTastes: z.boolean().default(false),
    previousShelf: z.boolean().default(false),
  })
  .strict();
export type Slot = z.infer<typeof slotSchema>;
export const revisionSchema = z
  .object({
    id: z.string(),
    fingerprint: z.string(),
    slots: z.array(slotSchema).max(3),
    excluded: z.array(z.string()).max(100),
    createdAt: z.string(),
    replacementKind: kindSchema.optional(),
  })
  .strict();
export type Revision = z.infer<typeof revisionSchema>;
export const draftSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    mode: modeSchema,
    sampleId: z.string().optional(),
    profileId: z.string().optional(),
    sender: z.string().trim().max(40),
    recipient: z.string().trim().max(40),
    introduction: z.string().trim().max(240),
    shelf: z.array(entrySchema).max(12),
    tastes: z.array(entitySchema).max(5),
    declaredBy: z.enum(["sender", "recipient"]),
    categories: z.array(kindSchema).min(2).max(3),
    known: z.array(z.string()).max(100),
    shared: z.array(z.string()).max(100),
    excluded: z.array(z.string()).max(100),
    revisions: z.array(revisionSchema).max(30),
    version: z.number().int(),
    shareIds: z.array(z.string()).max(50),
    updatedAt: z.string(),
    expiresAt: z.number(),
    deleted: z.boolean().default(false),
    returnCandidates: z.array(entitySchema).max(5).optional(),
    blockedSelections: z.array(z.object({ kind: kindSchema, fingerprint: z.string() }).strict()).max(3).optional(),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;
export const shareSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    draftId: z.string(),
    tokenHashes: z.array(z.string()).max(1),
    rotationNonce: z.string().optional(),
    generation: z.number().int().nonnegative().default(0),
    mode: modeSchema,
    sampleId: z.string().optional(),
    sender: z.string(),
    recipient: z.string(),
    introduction: z.string(),
    tastes: z.array(entitySchema),
    revision: revisionSchema,
    pool: z.array(entrySchema).max(12),
    repairEnabled: z.boolean(),
    revoked: z.boolean(),
    createdAt: z.string(),
    expiresAt: z.number(),
    idempotencyKey: z.string(),
    inputHash: z.string(),
  })
  .strict();
export type Share = z.infer<typeof shareSchema>;
export const receiptSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    shareId: z.string(),
    generation: z.number().int().nonnegative().default(0),
    blockedRepairs: z.array(z.object({ kind: kindSchema, fingerprint: z.string(), reason: z.literal("no_supported_result") }).strict()).max(3).default([]),
    version: z.number().int(),
    revisions: z.array(revisionSchema).max(30),
    known: z.array(z.string()).max(100),
    declined: z.array(z.string()).max(100),
    saved: z.array(z.string()).max(100),
    savedSlots: z.array(slotSchema).max(100).default([]),
    shown: z.array(z.string()).max(100),
    expiresAt: z.number(),
    lastReaction: z
      .object({
        kind: kindSchema,
        id: z.string(),
        action: z.enum(["known", "decline"]),
      })
      .optional(),
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
export const eventSchema = z
  .object({
    seq: z.number(),
    runId: z.string(),
    at: z.string(),
    type: z.enum([
      "accepted",
      "tool_started",
      "tool_completed",
      "decision",
      "needs_input",
      "version_saved",
      "cancelled",
      "failed",
    ]),
    label: z.string(),
    category: kindSchema.optional(),
    completed: z.number().optional(),
    requested: z.number().optional(),
    code: z.string().optional(),
    audit: z.object({
      tool: z.literal("rankShelfSlot"), attempt: z.number().int().min(1).max(2),
      eligible: z.number().int().nonnegative(), returned: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(),
      cache: z.enum(["hit", "miss", "illustrative"]), fetchedAt: z.string().nullable(),
      elapsedMs: z.number().nonnegative(), sourceRef: z.string().optional(),
    }).strict().optional(),
  })
  .strict();
export type RunEvent = z.infer<typeof eventSchema>;
export const runSchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    target: z.string(),
    receipt: z.boolean(),
    generation: z.number().int().nonnegative().optional(),
    action: z.enum(["prepare", "refine", "repair"]),
    slotId: kindSchema.optional(),
    expectedVersion: z.number(),
    key: z.string(),
    inputHash: z.string(),
    mode: modeSchema,
    status: z.enum([
      "accepted",
      "running",
      "ready",
      "needs_input",
      "failed",
      "cancelled",
    ]),
    cancelled: z.boolean(),
    events: z.array(eventSchema).max(80),
    attempts: z.number(),
    model: z.string(),
    reservedUsd: z.number(),
    createdAt: z.string(),
    expiresAt: z.number(),
    error: z.string().optional(),
    failure: z.object({ status: z.number().int(), resetAt: z.number().optional() }).strict().optional(),
    resultVersion: z.number().optional(),
    partialSlots: z.array(slotSchema).max(3).optional(),
    diagnostics: z.object({
      policy: z.literal("bounded-selection-2"),
      latencyMs: z.number().nonnegative(),
      inputBounds: z.array(z.number()).max(4),
      steps: z.array(z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), totalTokens: z.number().nullable() })).max(4),
      toolCalls: z.number(),
      cacheHits: z.number(),
      reservedUsd: z.number(),
      settledUsd: z.number().nullable(),
    }).optional(),
  })
  .strict();
export type Run = z.infer<typeof runSchema>;
export function validateCoverage(d: Draft, repair?: Kind) {
  if (
    new Set(d.categories).size !== d.categories.length ||
    new Set(d.shelf.map((e) => e.entity.id)).size !== d.shelf.length ||
    new Set(d.tastes.map((e) => e.id)).size !== d.tastes.length
  )
    throw new Error("Duplicate choices are not allowed.");
  if (
    d.tastes.length < 3 ||
    d.tastes.length > 5 ||
    (!repair && (d.shelf.length < 6 || d.shelf.length > 12))
  )
    throw new Error("Add enough favourites and three tastes to continue.");
  for (const k of repair ? [repair] : d.categories)
    if (eligibility(d, k).length < (repair ? 1 : 2))
      throw new Error(`Add one more ${singular[k]} to give us a choice.`);
  if (
    d.shelf.some((e) => e.entity.mode !== d.mode) ||
    d.tastes.some((e) => e.mode !== d.mode)
  )
    throw new Error("Sample and live choices cannot be mixed.");
}
export type Gift = Pick<
  Share,
  | "id"
  | "generation"
  | "mode"
  | "sampleId"
  | "sender"
  | "recipient"
  | "introduction"
  | "tastes"
  | "repairEnabled"
  | "expiresAt"
> & {
  slots: Slot[];
  receiptId?: string;
  version?: number;
  saved?: string[];
  savedSlots?: Slot[];
  known?: string[];
  declined?: string[];
  undoKind?: Kind;
  blockedRepairs?: Kind[];
  ordinals?: Partial<Record<Kind, number>>;
};
export function giftProjection(s: Share, r?: Receipt): Gift {
  return {
    id: s.id,
    generation: s.generation,
    mode: s.mode,
    sampleId: s.sampleId,
    sender: s.sender,
    recipient: s.recipient,
    introduction: s.introduction,
    tastes: s.tastes,
    repairEnabled: s.repairEnabled,
    expiresAt: s.expiresAt,
    slots: (r ? current(r) : s.revision)!.slots,
    ordinals: Object.fromEntries(s.revision.slots.map((slot, i) => [slot.kind, i])),
    ...(r
      ? {
          receiptId: r.id,
          blockedRepairs: r.blockedRepairs.map((block) => block.kind),
          version: r.version,
          saved: r.saved,
          savedSlots: r.saved.map((id) => r.savedSlots.find((slot) => slot.entity.id === id) ?? r.revisions.flatMap((revision) => revision.slots).find((slot) => slot.entity.id === id)).filter((slot): slot is Slot => Boolean(slot)),
          known: r.known,
          declined: r.declined,
          undoKind: r.revisions[replacementIndex(r.revisions)]?.replacementKind,
        }
      : {}),
  };
}
