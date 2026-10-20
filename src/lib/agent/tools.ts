import { supportedDetail } from "../readings";
import "server-only";
import { z } from "zod";
import { tool } from "ai";
import {
  current,
  eligibility,
  kindSchema,
  labels,
  singular,
  type Draft,
  type Kind,
  type Slot,
  type RunEvent,
} from "../domain";
import type { QlooClient } from "../qloo/client";
import { SCHEMA_VERSION, type QlooEntity } from "../qloo/schemas";
import { entityKind, normalizedId, contributions, invalidRequiredSignals } from "../qloo/normalize";
import { opaque, hash } from "../server/security";
import { AppError } from "../server/errors";
export type RankReply = {
  status: "ok" | "partial" | "empty" | "needs_input";
  ref?: string;
  returned: number;
  eligible: number;
  missing: number;
  rejected: number;
  retryAllowed: boolean;
  reason?: string;
};
export const inputFingerprint = (d: Draft) =>
  hash(
    JSON.stringify({
      mode: d.mode,
      shelf: d.shelf.map((e) => [e.entity.id, e.entity.kind]),
      signals: d.tastes.map((e) => e.id),
      categories: d.categories,
      known: d.known,
      shared: d.shared,
      excluded: d.excluded,
    }),
  );
export const selectionShelfFingerprint = (d: Draft, kind: Kind) => hash(JSON.stringify(
  d.shelf.filter((e) => e.entity.kind === kind && !d.known.includes(e.entity.id) && !d.excluded.includes(e.entity.id))
    .map((e) => e.entity.id).sort(),
));
export function filterRanking(
  rows: QlooEntity[],
  candidates: string[],
  kind: Kind,
  excluded: string[],
) {
  const pool = new Set(candidates.map(normalizedId)),
    deny = new Set(excluded.map(normalizedId)),
    seen = new Set<string>();
  const invalidCandidates: string[] = [];
  const valid: QlooEntity[] = [];
  for (const e of rows) {
    const id = normalizedId((e.entity_id ?? e.id)!);
    const type = entityKind(e);
    if (pool.has(id) && type !== kind) {
      invalidCandidates.push(id);
      continue;
    }
    if (
      !pool.has(id) ||
      deny.has(id) ||
      type !== kind ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    valid.push(e);
  }
  return {
    valid,
    invalidCandidates: [...new Set(invalidCandidates)],
    rejected: rows.length - valid.length,
    missing: candidates.filter((id) => !seen.has(normalizedId(id))).length,
  };
}
export class SelectionTools {
  readonly results = new Map<string, Slot>();
  readonly refs = new Map<Kind, string>();
  readonly outcomes = new Map<Kind, RankReply>();
  readonly removed = new Map<Kind, string[]>();
  readonly calls = new Map<Kind, number>();
  readonly invalidIdentities = new Set<string>();
  toolCalls = 0;
  blocked = false;
  committed = false;
  toolFeedback: string | null = null;
  terminalError: unknown;
  clarification?: { slotId: Kind; reason: string };
  readonly audit: { inputBounds: number[]; steps: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }[] } = { inputBounds: [], steps: [] };
  constructor(
    readonly draft: Draft,
    readonly qloo: Pick<QlooClient, "insights" | "getEntities"> | null,
    readonly signal: AbortSignal,
    readonly event: (
      type: RunEvent["type"],
      label: string,
      category?: Kind,
      code?: string,
      audit?: RunEvent["audit"],
    ) => Promise<void>,
    readonly check: () => Promise<void>,
    readonly repair?: Kind,
    readonly carried: ReadonlySet<string> = new Set(),
  ) {}
  private async guard() {
    this.signal.throwIfAborted();
    await this.check();
    if (++this.toolCalls > 12)
      throw new AppError(
        503,
        "The agent could not finish this mixtape. Your last version is unchanged.",
      );
  }
  needed() {
    return this.repair
      ? [this.repair]
      : this.draft.categories.filter(
          (k) =>
            !current(this.draft)?.slots.find((s) => s.kind === k && s.locked),
        );
  }
  async rank(slotId: Kind, revision: number): Promise<RankReply> {
    const started = Date.now();
    await this.guard();
    if (revision !== this.draft.version || !this.needed().includes(slotId))
      throw new AppError(400, "That slot cannot be changed in this run.");
    const n = this.calls.get(slotId) ?? 0;
    const previous = this.outcomes.get(slotId);
    if (n > 0 && (!previous?.retryAllowed || n >= 2))
      throw new AppError(400, "An identical ranking cannot be retried.");
    const extra = [
      ...this.invalidIdentities,
      ...(this.removed.get(slotId) ?? []),
      ...(current(this.draft)
        ?.slots.filter((s) => s.kind !== slotId)
        .map((s) => s.entity.id) ?? []),
    ];
    const candidates = eligibility(this.draft, slotId, extra);
    this.calls.set(slotId, n + 1);
    if (!candidates.length) {
      const r: RankReply = {
        status: "needs_input",
        eligible: 0,
        returned: 0,
        missing: 0,
        rejected: 0,
        retryAllowed: false,
        reason: "shelf_exhausted",
      };
      this.outcomes.set(slotId, r);
      await this.event(
        "needs_input",
        `There is no other ${singular[slotId]} in this mixtape.`,
        slotId,
        "shelf_exhausted",
      );
      return r;
    }
    await this.event(
      "tool_started",
      this.repair
        ? `Finding another ${singular[slotId]}. The other pieces will stay.`
        : `Finding ${labels[slotId].toLowerCase()} for ${this.draft.recipient || "your friend"}.`,
      slotId,
    );
    const deny = [
      ...new Set([
        ...this.draft.tastes.map((e) => e.id),
        ...this.draft.known,
        ...this.draft.shared,
        ...this.draft.excluded,
        ...extra,
      ]),
    ];
    const warnings: string[] = [];
    let rows: QlooEntity[],
      time: string | null = null,
      cache: "hit" | "miss" | "illustrative" = "illustrative";
    if (this.draft.mode === "fixture") {
      // A synthetic order for interaction tests, never an affinity simulation.
      const offset =
        this.draft.tastes.reduce(
          (v, e) => v + e.id.charCodeAt(e.id.length - 1),
          0,
        ) % candidates.length;
      const ordered = [
        ...candidates.slice(offset),
        ...candidates.slice(0, offset),
      ];
      rows = ordered.map((e) => ({
        entity_id: e.entity.id,
        name: e.entity.name,
        subtype: `urn:entity:${slotId}`,
      }));
    } else {
      if (!this.qloo)
        throw new AppError(503, "We cannot reach Qloo with this setup.");
      const r = await this.qloo.insights(
        {
          "filter.type": `urn:entity:${slotId}`,
          "signal.interests.entities": this.draft.tastes.map((e) => e.id),
          "filter.results.entities": candidates.map((e) => e.entity.id),
          ...(deny.length ? { "filter.exclude.entities": deny } : {}),
          "feature.explainability": true,
          take: candidates.length,
          sort_by: "affinity",
        },
        { signal: this.signal, cacheTtlMs: 300000 },
      );
      const invalidSignals = invalidRequiredSignals(r.data.warnings, this.draft.tastes.map((e) => e.id));
      if (invalidSignals.length) {
        this.blocked = true;
        const names = this.draft.tastes.filter((e) => invalidSignals.includes(normalizedId(e.id))).map((e) => e.name);
        throw new AppError(400, `Qloo cannot use ${names.join(", ")} as a taste. Choose another identity or a different taste. Your current mixtape is unchanged.`);
      }
      rows = r.data.results.entities;
      // Only allowlisted product warnings cross the capability boundary; never
      // echo arbitrary upstream strings (which can contain private metadata).
      const hasWarning = (value: unknown) => Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0;
      const explanation = r.data.query?.explainability as { warning?: unknown } | undefined;
      if (hasWarning(r.data.warnings) || hasWarning(explanation?.warning) || rows.some((row) => hasWarning(row.query?.explainability?.warning)))
        warnings.push("Qloo reported a warning. Individual connections may be incomplete.");
      time = r.provenance.fetchedAt;
      cache = r.provenance.cache;
    }
    await this.check();
    this.signal.throwIfAborted();
    const filtered = filterRanking(
      rows,
      candidates.map((e) => e.entity.id),
      slotId,
      deny,
    );
    const retryAllowed =
      filtered.invalidCandidates.length > 0 &&
      n === 0 &&
      candidates.length > filtered.invalidCandidates.length;
    if (retryAllowed) {
      this.removed.set(slotId, filtered.invalidCandidates);
      await this.event(
        "decision",
        "A candidate had the wrong category. A changed shortlist can be checked once.",
        slotId,
        "retry_valid_subset",
      );
    }
    const first = filtered.valid[0];
    let ref: string | undefined;
    if (first) {
      const id = normalizedId((first.entity_id ?? first.id)!);
      const e = candidates.find((e) => normalizedId(e.entity.id) === id)!;
      ref = opaque();
      const score = first.query?.affinity ?? first.affinity ?? null;
      const connections = this.draft.mode === "live" ? contributions(first, this.draft.tastes.map((e) => e.id)) : undefined;
      this.results.set(ref, {
        kind: slotId,
        entity: e.entity,
        note: e.note,
        locked: false,
        method: this.draft.mode === "fixture" ? "illustrative" : "qloo",
        previousTastes: false,
        previousShelf: false,
        evidence: {
          mode: this.draft.mode,
          category: slotId,
          signals: this.draft.tastes,
          fingerprint: inputFingerprint(this.draft),
          shelfFingerprint: selectionShelfFingerprint(this.draft, slotId),
          eligibleCount: candidates.length,
          returnedCount: filtered.valid.length,
          missingCount: filtered.missing,
          rejectedCount: filtered.rejected,
          rank: 1,
          selectedId: id,
          score: this.draft.mode === "fixture" ? null : score,
          fetchedAt: time,
          cache,
          schema: SCHEMA_VERSION,
          ...(connections ? { contributions: connections } : {}),
          explanationStatus: connections?.length ? "verified" : warnings.length ? "failed" : first.query?.explainability
            ? "unverified"
            : "unavailable",
          warnings: [...warnings, ...(filtered.rejected ? ["Unsupported records were excluded."] : [])],
        },
      });
      this.refs.set(slotId, ref);
    }
    const reply: RankReply = {
      status: first ? (filtered.rejected ? "partial" : "ok") : "empty",
      ref,
      eligible: candidates.length,
      returned: filtered.valid.length,
      missing: filtered.missing,
      rejected: filtered.rejected,
      retryAllowed,
    };
    this.outcomes.set(slotId, reply);
    await this.event(
      "tool_completed",
      this.draft.mode === "fixture"
        ? `Illustrative sample · ${filtered.valid.length} ${singular[slotId]} choices checked.`
        : cache === "hit"
          ? `Using a Qloo result from ${time}.`
          : `Qloo returned ${filtered.valid.length} ${singular[slotId]}${filtered.valid.length === 1 ? "" : "s"} from your shelf.`,
      slotId,
      retryAllowed ? "retry_pending" : "slot_checked",
      { tool: "rankShelfSlot", attempt: n + 1, eligible: candidates.length, returned: filtered.valid.length, missing: filtered.missing, rejected: filtered.rejected, cache, fetchedAt: time, elapsedMs: Date.now() - started, ...(ref ? { sourceRef: ref } : {}) },
    );
    return reply;
  }
  async requestInput(
    slotId: Kind,
    reason:
      | "identity_missing"
      | "shelf_exhausted"
      | "no_supported_result"
      | "invalid_kept_item",
  ) {
    await this.guard();
    if (!this.draft.categories.includes(slotId))
      throw new AppError(400, "Unknown slot.");
    const outcome = this.outcomes.get(slotId);
    const valid = reason === "shelf_exhausted"
      ? outcome?.reason === "shelf_exhausted" && outcome.eligible === 0
      : reason === "no_supported_result"
        ? outcome?.status === "empty" && !outcome.ref && !outcome.retryAllowed
        : reason === "identity_missing"
          ? this.draft.shelf.some((e) => e.entity.kind === slotId && this.invalidIdentities.has(e.entity.id))
          : !!current(this.draft)?.slots.some((s) => s.kind === slotId && s.locked && !eligibility({ ...this.draft, shared: this.draft.shared.filter((id) => !this.carried.has(id)) }, slotId).some((e) => e.entity.id === s.entity.id));
    if (!valid) throw new AppError(503, "The agent could not finish this mixtape. Your last version is unchanged.");
    this.clarification = { slotId, reason };
    this.blocked = true;
    await this.event(
      "needs_input",
      reason === "shelf_exhausted"
        ? `There is no other ${singular[slotId]} in this mixtape.`
        : "Qloo did not return a choice from these favourites.",
      slotId,
      reason,
    );
    return { status: "needs_input" as const, reason };
  }
  async hydrate(entityIds: string[]) {
    await this.guard();
    const allowed = new Set(this.draft.shelf.map((e) => e.entity.id));
    if (
      !entityIds.length ||
      entityIds.length > 12 ||
      entityIds.some((id) => !allowed.has(id))
    )
      throw new AppError(400, "Only confirmed favourites can be checked.");
    if (this.draft.mode === "fixture") return { status: "ok", missing: [] };
    await this.event("tool_started", "Checking your favourites.");
    const result = await this.qloo!.getEntities(
      { entity_ids: entityIds },
      { signal: this.signal, cacheTtlMs: 3600000 },
    );
    const missing = entityIds.filter((id) => {
      const expected = this.draft.shelf.find((e) => e.entity.id === id)!.entity;
      return !result.data.results.some((e) => normalizedId((e.entity_id ?? e.id)!) === normalizedId(id) &&
        entityKind(e) === expected.kind);
    });
    for (const id of missing) this.invalidIdentities.add(id);
    // An explicitly checked identity that disappeared needs human reconfirmation.
    // Ranking or a model ignoring this reply cannot make it eligible again.
    if (missing.length) this.blocked = true;
    return { status: missing.length ? "needs_input" : "ok", missing };
  }
  async commit(candidateRefs: string[]) {
    await this.guard();
    if (this.blocked)
      throw new AppError(400, "Add another favourite or change the tastes.");
    const slots: Slot[] = [];
    for (const kind of this.draft.categories) {
      const old = current(this.draft)?.slots.find((s) => s.kind === kind);
      if (
        old &&
        ((this.repair && kind !== this.repair) || (!this.repair && old.locked))
      ) {
        const still =
          this.draft.shelf.some((e) => e.entity.id === old.entity.id) &&
          !this.draft.tastes.some((e) => e.id === old.entity.id) &&
          !this.draft.known.includes(old.entity.id) &&
          (!this.draft.shared.includes(old.entity.id) || this.carried.has(old.entity.id)) &&
          !this.draft.excluded.includes(old.entity.id);
        if (this.invalidIdentities.has(old.entity.id) || (!this.repair && !still))
          throw new AppError(
            400,
            `${old.entity.name} is no longer eligible. Let Mixtape choose another.`,
          );
        slots.push(old);
        continue;
      }
      const ref = this.refs.get(kind);
      if (!ref || !candidateRefs.includes(ref))
        throw new AppError(
          400,
          "Every changed choice needs a valid result reference.",
        );
      const slot = this.results.get(ref);
      if (
        !slot ||
        this.invalidIdentities.has(slot.entity.id) ||
        !eligibility(this.draft, kind).some(
          (e) => e.entity.id === slot.entity.id,
        )
      )
        throw new AppError(400, "The choice is no longer eligible.");
      slots.push(slot);
    }
    if (new Set(slots.map((s) => s.entity.id)).size !== slots.length)
      throw new AppError(400, "Duplicate choices are not allowed.");
    this.committed = true;
    await this.event("decision", "Checking the choices.");
    return slots;
  }
  highlightConnections(choices: { candidateRef: string; signalIndex: number; interpretation?: string }[]) {
    const validated = choices.map(({ candidateRef, signalIndex, interpretation }) => {
      const slot = this.results.get(candidateRef);
      const signal = slot?.evidence.signals[signalIndex];
      if (!slot || !signal || slot.evidence.mode !== "live" || slot.evidence.explanationStatus !== "verified" || signal.kind === slot.kind ||
        !slot.evidence.contributions?.some((c) => normalizedId(c.entityId) === normalizedId(signal.id) && c.score > 0))
        throw new AppError(400, "A highlighted connection needs reported cross-category evidence.");
      if (interpretation && !supportedDetail(slot.entity, interpretation))
        throw new AppError(400, "Use an exact supplied detail about the new pick, or omit interpretation.");
      return { slot, signal, interpretation };
    });
    if (new Set(validated.map(({ slot }) => slot.kind)).size !== validated.length)
      throw new AppError(400, "Highlight only one connection per piece.");
    for (const { slot, signal, interpretation } of validated) {
      slot.evidence.highlightedSignalId = signal.id;
      if (interpretation) slot.evidence.readingDetail = interpretation;
    }
  }
  tools() {
    return {
      rankNeededSlots: tool({
        description: "Rank all unfinished required slots. One later call may check only changed subsets marked retryAllowed. Never repeats a valid empty result.",
        inputSchema: z.object({ revision: z.number().int() }).strict(),
        execute: async ({ revision }) => {
          const needed = this.needed().filter((kind) => !this.outcomes.has(kind) || this.outcomes.get(kind)?.retryAllowed);
          if (!needed.length) throw new AppError(400, "An identical ranking cannot be retried.");
          // Bounded batches keep the global two-request ceiling intact.
          try {
            for (let i = 0; i < needed.length; i += 2) {
              const batch = await Promise.allSettled(needed.slice(i, i + 2).map((kind) => this.rank(kind, revision)));
              const failed = batch.find((result) => result.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
            }
          } catch (error) {
            this.terminalError = error;
            throw error;
          }
          return needed.map((kind) => ({ kind, ...this.outcomes.get(kind)! }));
        },
      }),
      requestInput: tool({
        description:
          "Stop and request input for an empty, exhausted or invalid slot. Do not broaden discovery.",
        inputSchema: z
          .object({
            slotId: kindSchema,
            reason: z.enum([
              "identity_missing",
              "shelf_exhausted",
              "no_supported_result",
              "invalid_kept_item",
            ]),
          })
          .strict(),
        execute: async ({ slotId, reason }) => {
          try { return await this.requestInput(slotId, reason); }
          catch (error) {
            this.toolFeedback = "requestInput rejected: only listed slots with a supported empty, exhausted or invalid outcome need input. Kept slots are complete.";
            throw error;
          }
        },
      }),
      commitDraft: tool({
        description:
          "Commit refs. Choose a recipient signal and optionally copy one exact allowedDetail about the new pick. Never write a whole sentence.",
        inputSchema: z
          .object({ candidateRefs: z.array(z.string()).max(3), connections: z.array(z.object({ candidateRef: z.string(), signalIndex: z.number().int().min(0).max(4), interpretation: z.string().min(1).max(180).optional() }).strict()).max(3).optional() })
          .strict(),
        execute: async ({ candidateRefs, connections }) => {
          try {
            this.highlightConnections(connections ?? []);
            await this.commit(candidateRefs);
            this.toolFeedback = null;
          } catch (error) {
            // Compact state replaces tool transcripts. Preserve our own bounded
            // validation feedback so the next turn can correct a rejected call.
            this.toolFeedback = error instanceof AppError ? error.message.slice(0, 160) : "The commit could not be validated.";
            throw error;
          }
          return { status: "validated" as const };
        },
      }),
    };
  }
}
