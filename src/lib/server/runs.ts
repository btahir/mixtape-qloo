import "server-only";
import { z } from "zod";
import {
  current,
  eligibility,
  singular,
  draftSchema,
  receiptSchema,
  shareSchema,
  runSchema,
  validateCoverage,
  type Run,
  type Draft,
  type Kind,
  type RunEvent,
} from "../domain";
import { selectionBlocked, selectionRequestKey } from "../domain-view";
import { selectionCacheScope } from "./sample-manifest";
import { SelectionTools, inputFingerprint } from "../agent/tools";
import { executionMode, hasAnthropic, modelId, runSelection, verifyModelPolicy, verifySelectionBudget } from "../agent";
import { owned, ownedReceipt, repairDraft, activityWrites, publishedPieces } from "./repository";
import { DAY, MONTH, put, read, update, store, withStoreDeadline, type Write } from "./store";
import { hash, opaque } from "./security";
import { rate, reserve, settle, ensureQlooAccess } from "./limits";
import { client, qlooFailure } from "./qloo";
import { AppError, conflict, gone } from "./errors";
export const agentInput = z
  .object({
    action: z.enum(["prepare", "refine", "repair"]),
    draftId: z.string().max(100).optional(),
    receiptRef: z.string().max(100).optional(),
    slotId: z.enum(["movie", "book", "artist"]).optional(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(100),
  })
  .strict()
  .refine(
    (p) => Boolean(p.draftId) !== Boolean(p.receiptRef),
    "Choose exactly one target",
  )
  .refine((p) => p.action !== "repair" || !!p.slotId, "Repair needs a slot");
const controllers = new Map<string, AbortController>();
export async function ownedRun(id: string, owner: string) {
  const r = await read(`run:${id}`, runSchema);
  if (!r || r.owner !== owner) throw gone();
  if (r.receipt) { const { s } = await ownedReceipt(r.target, owner); if (s.generation !== (r.generation ?? 0)) throw gone(); }
  if (["accepted", "running"].includes(r.status) && Date.now() > Date.parse(r.createdAt) + 50000 && !controllers.has(id))
    return update(`run:${id}`, runSchema, (latest) => {
      if (!latest || !["accepted", "running"].includes(latest.status)) return latest ?? r;
      return { ...latest, status: "failed" as const, cancelled: true, error: "The connection was interrupted.", failure: { status: 503 } };
    }, DAY);
  return r;
}
export async function cancelRun(id: string, owner: string) {
  await ownedRun(id, owner);
  const run = await update(
    `run:${id}`,
    runSchema,
    (r) => {
      if (!r || r.owner !== owner) throw gone();
      return { ...r, cancelled: true };
    },
    DAY,
  );
  controllers.get(id)?.abort();
  return { id: run.id, cancelled: true };
}
async function inputDraft(
  p: z.infer<typeof agentInput>,
  owner: string,
): Promise<Draft> {
  if (p.receiptRef) {
    if (p.action !== "repair")
      throw new AppError(400, "A receipt can only replace one piece.");
    const { r, s } = await ownedReceipt(p.receiptRef, owner);
    if (!s.repairEnabled)
      throw new AppError(403, "The sender kept this mixtape as it is.");
    return repairDraft(s, r);
  }
  return owned(p.draftId!, owner);
}
function repairFingerprint(draft: Draft, kind: Kind) {
  return hash(JSON.stringify({ kind, tastes: draft.tastes.map((e) => e.id), candidates: eligibility(draft, kind).map((e) => e.entity.id) }));
}
export async function startRun(
  p: z.infer<typeof agentInput>,
  owner: string,
  ip: string,
  notAfter = Date.now() + 45000,
) {
  const inputHash = hash(JSON.stringify(p)),
    idKey = `run-key:${owner}:${hash(p.idempotencyKey)}`;
  const existing = await read(
    idKey,
    z.object({ id: z.string(), hash: z.string() }),
  );
  if (existing) {
    if (existing.hash !== inputHash) throw conflict();
    return {
      run: await ownedRun(existing.id, owner),
      draft: null,
      replay: true,
    };
  }
  const receipt = p.receiptRef ? await ownedReceipt(p.receiptRef, owner) : null;
  const draft = await inputDraft(p, owner);
  if (draft.version !== p.expectedVersion) throw conflict();
  if (p.action === "repair") {
    const old = current(draft)?.slots.find((s) => s.kind === p.slotId);
    if (!old) throw new AppError(400, "Make their mixtape first.");
    draft.excluded = [...new Set([...draft.excluded, old.entity.id])];
  }
  if (!receipt && (p.action === "repair" ? [p.slotId!] : draft.categories.filter((kind) => !current(draft)?.slots.find((s) => s.kind === kind)?.locked)).some((kind) => selectionBlocked(draft, kind)))
    throw new AppError(400, "Qloo did not return a choice from these favourites.");
  if (receipt && p.slotId && receipt.r.blockedRepairs.some((b) => b.kind === p.slotId && b.fingerprint === repairFingerprint(draft, p.slotId!)))
    throw new AppError(400, "Qloo did not return a choice from these favourites.");
  if (p.receiptRef && p.slotId && !eligibility(draft, p.slotId).length)
    throw new AppError(400, `There is no other ${singular[p.slotId]} in this mixtape.`);
  try {
    validateCoverage(draft, p.action === "repair" ? p.slotId : undefined);
  } catch (e) {
    throw new AppError(
      400,
      e instanceof Error ? e.message : "Add more favourites.",
    );
  }
  if (draft.mode === "live") {
    ensureQlooAccess();
  }
  const paid = draft.mode === "live" && executionMode() === "anthropic";
  if (paid && !hasAnthropic()) throw new AppError(503, "New mixtapes are paused for now. Saved links still work.");
  if (paid) verifyModelPolicy();
  if (paid) await verifySelectionBudget(new SelectionTools(draft, null, new AbortController().signal, async () => {}, async () => {}, p.slotId));
  await rate("inference", owner, ip);
  const id = `${new Date().toISOString().slice(0, 10)}:${opaque()}`;
  // Claim idempotency before reserving. Competing identical requests replay only.
  try {
    await put(
      idKey,
      z.object({ id: z.string(), hash: z.string() }),
      { id, hash: inputHash },
      DAY,
    );
  } catch (e) {
    const win = await read(
      idKey,
      z.object({ id: z.string(), hash: z.string() }),
    );
    if (win) {
      if (win.hash !== inputHash) throw conflict();
      const run = await read(`run:${win.id}`, runSchema);
      if (run) return { run, draft: null, replay: true };
      throw new AppError(
        409,
        "This mixtape is already starting. Check latest version.",
      );
    }
    throw e;
  }
  const run: Run = {
    id,
    owner,
    target: p.receiptRef ?? p.draftId!,
    receipt: !!p.receiptRef,
    generation: receipt?.s.generation,
    action: p.action,
    slotId: p.slotId,
    expectedVersion: p.expectedVersion,
    key: p.idempotencyKey,
    inputHash,
    mode: draft.mode,
    status: "accepted",
    cancelled: false,
    events: [],
    attempts: 0,
    model: paid ? modelId() : "deterministic-local-stub",
    reservedUsd: paid ? 0.02 : 0,
    createdAt: new Date(notAfter - 45000).toISOString(),
    expiresAt: Date.now() + DAY,
  };
  try {
    await reserve(id, owner, paid);
    await put(`run:${id}`, runSchema, run, DAY);
  } catch (e) {
    await update(
      `run:${id}`,
      runSchema,
      (old) => ({
        ...(old ?? run),
        status: "failed" as const,
        error: qlooFailure(e).message,
      }),
      DAY,
    );
    await settle(id, undefined).catch(() => {});
    throw e;
  }
  return { run, draft, replay: false };
}
export async function executeRun(
  run: Run,
  draft: Draft,
  emit: (event: RunEvent) => void,
  requestSignal?: AbortSignal,
) {
  const deadline = Date.parse(run.createdAt) + 45000;
  const remaining = Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  controllers.set(run.id, controller);
  const signal = requestSignal
    ? AbortSignal.any([
        controller.signal,
        requestSignal,
        AbortSignal.timeout(remaining),
      ])
    : AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
  const completedSlots = new Set<Kind>(
    run.action === "repair"
      ? []
      : draft.categories.filter((kind) =>
          current(draft)?.slots.some(
            (slot) => slot.kind === kind && slot.locked,
          ),
        ));
  const requested = run.action === "repair" ? 1 : draft.categories.length;
  const check = async () => {
    signal.throwIfAborted();
    if (process.env.PAUSE_GENERATION === "true")
      throw new AppError(
        503,
        "New mixtapes are paused for now. Saved links still work.",
      );
    const state = await ownedRun(run.id, run.owner);
    if (state.cancelled)
      throw new AppError(409, "Stopped. Your draft is still here.");
    if (run.receipt) {
      const { s } = await ownedReceipt(run.target, run.owner);
      if (s.generation !== run.generation) throw gone();
    }
    else await owned(run.target, run.owner);
  };
  const event = async (
    type: RunEvent["type"],
    label: string,
    category?: Kind,
    code?: string,
    audit?: RunEvent["audit"],
  ) => {
    if (category && type === "tool_started") completedSlots.delete(category);
    if (category && (type === "needs_input" || (type === "tool_completed" && code !== "retry_pending")))
      completedSlots.add(category);
    let output: RunEvent | undefined;
    await update(
      `run:${run.id}`,
      runSchema,
      (r) => {
        if (!r) throw gone();
        output = {
          seq: r.events.length + 1,
          runId: run.id,
          at: new Date().toISOString(),
          type,
          label,
          category,
          code,
          audit,
          completed: completedSlots.size,
          requested,
        };
        return { ...r, events: [...r.events, output].slice(-80) };
      },
      DAY,
    );
    if (output) emit(output);
  };
  let polling = false;
  const poll = setInterval(() => {
    if (polling || signal.aborted) return;
    polling = true;
    void withStoreDeadline(signal, deadline, () => ownedRun(run.id, run.owner))
      .then((state) => { if (state.cancelled) controller.abort(); })
      .catch(() => {}).finally(() => { polling = false; });
  }, 250);
  let actual: number | undefined;
  let tools: SelectionTools | undefined;
  try {
    await withStoreDeadline(signal, deadline, async () => {
    await event("accepted", "Your mixtape is queued.");
    await update(
      `run:${run.id}`,
      runSchema,
      (r) => ({ ...r!, status: "running" as const }),
      DAY,
    );
    const q =
      draft.mode === "live"
        ? client(await selectionCacheScope(draft), async () => {
            await check();
            await update(
              `run:${run.id}`,
              runSchema,
              (r) => {
                if (!r || r.attempts >= 6)
                  throw new AppError(503, "The Qloo call limit was reached.");
                return { ...r, attempts: r.attempts + 1 };
              },
              DAY,
            );
          })
        : null;
    const t = new SelectionTools(
      draft,
      q,
      signal,
      event,
      check,
      run.action === "repair" ? run.slotId : undefined,
      run.receipt ? undefined : await publishedPieces(draft),
    );
    tools = t;
    const result = await runSelection(t);
    await check();
    if (result.status === "needs_input") {
      const runKey = `run:${run.id}`, runRaw = await store().get(runKey);
      if (!runRaw) throw gone();
      const stored = runSchema.parse(JSON.parse(runRaw));
      if (stored.cancelled) throw new AppError(409, "Stopped. Your draft is still here.");
      const writes: Write[] = [];
      let resultVersion: number | undefined;
      if (run.receipt && run.slotId && t.clarification?.reason === "no_supported_result") {
        const { r, s } = await ownedReceipt(run.target, run.owner);
        const receiptKey = `receipt:${r.id}`, shareKey = `share:${s.id}`;
        const [receiptRaw, shareRaw] = await Promise.all([store().get(receiptKey), store().get(shareKey)]);
        if (!receiptRaw || !shareRaw) throw gone();
        const latestReceipt = receiptSchema.parse(JSON.parse(receiptRaw)), latestShare = shareSchema.parse(JSON.parse(shareRaw));
        if (latestShare.revoked || latestShare.generation !== run.generation || latestReceipt.generation !== run.generation) throw gone();
        if (latestReceipt.version !== run.expectedVersion) throw conflict();
        latestReceipt.blockedRepairs = [...latestReceipt.blockedRepairs.filter((b) => b.kind !== run.slotId),
          { kind: run.slotId, fingerprint: repairFingerprint(draft, run.slotId), reason: "no_supported_result" }];
        resultVersion = ++latestReceipt.version;
        writes.push({ key: shareKey, old: shareRaw, value: shareRaw, ttlMs: s.expiresAt - Date.now() },
          { key: receiptKey, old: receiptRaw, value: JSON.stringify(latestReceipt), ttlMs: r.expiresAt - Date.now() });
      }
      if (!run.receipt && t.clarification?.reason === "no_supported_result") {
        const key = `draft:${run.target}`, raw = await store().get(key);
        if (!raw) throw gone();
        const latest = draftSchema.parse(JSON.parse(raw));
        if (latest.deleted || latest.owner !== run.owner || latest.version !== run.expectedVersion) throw conflict();
        const kind = t.clarification.slotId;
        latest.blockedSelections = [...(latest.blockedSelections ?? []).filter((b) => b.kind !== kind), { kind, fingerprint: selectionRequestKey(draft, kind) }];
        writes.push({ key, old: raw, value: JSON.stringify(latest), ttlMs: latest.expiresAt - Date.now() });
      }
      signal.throwIfAborted();
      writes.push({ key: runKey, old: runRaw, value: JSON.stringify(runSchema.parse({ ...stored, status: "needs_input", partialSlots: run.receipt ? [] : result.slots, resultVersion })), ttlMs: DAY });
      if (!(await store().batchCas(writes))) throw conflict();
      actual = run.reservedUsd === 0 ? 0 : undefined;
      return;
    }
    const revision = {
      id: opaque(),
      fingerprint: inputFingerprint(draft),
      slots: result.slots,
      excluded: draft.excluded,
      createdAt: new Date().toISOString(),
      ...(run.action === "repair" ? { replacementKind: run.slotId } : {}),
    };
    // Compare the cancellation record and target version in the same transaction.
    // A cancellation from any function instance wins over a stale commit attempt.
    const targetKey = `${run.receipt ? "receipt" : "draft"}:${run.target}`;
    const targetRaw = await store().get(targetKey),
      runRaw = await store().get(`run:${run.id}`);
    if (!targetRaw || !runRaw) throw gone();
    const storedRun = runSchema.parse(JSON.parse(runRaw));
    signal.throwIfAborted();
    if (storedRun.cancelled)
      throw new AppError(409, "Stopped. Your draft is still here.");
    let targetValue: string, ttl: number, resultVersion: number;
    const guards: Write[] = [];
    if (run.receipt) {
      const { s } = await ownedReceipt(run.target, run.owner);
      if (s.revoked) throw gone();
      const shareRaw = await store().get(`share:${s.id}`);
      if (!shareRaw) throw gone();
      const latestShare = shareSchema.parse(JSON.parse(shareRaw));
      if (latestShare.revoked || latestShare.generation !== run.generation || latestShare.expiresAt <= Date.now()) throw gone();
      guards.push({
        key: `share:${s.id}`,
        old: shareRaw,
        value: shareRaw,
        ttlMs: s.expiresAt - Date.now(),
      });
      const r = receiptSchema.parse(JSON.parse(targetRaw));
      if (r.generation !== latestShare.generation) throw gone();
      if (r.owner !== run.owner || r.version !== run.expectedVersion)
        throw conflict();
      r.revisions = [...r.revisions, revision].slice(-30);
      delete r.lastReaction;
      r.blockedRepairs = r.blockedRepairs.filter((b) => b.kind !== run.slotId);
      r.shown = [
        ...new Set([...r.shown, ...revision.slots.map((s) => s.entity.id)]),
      ];
      r.version++;
      resultVersion = r.version;
      ttl = r.expiresAt - Date.now();
      targetValue = JSON.stringify(receiptSchema.parse(r));
    } else {
      const d = draftSchema.parse(JSON.parse(targetRaw));
      if (
        d.owner !== run.owner ||
        d.deleted ||
        d.version !== run.expectedVersion
      )
        throw conflict();
      d.revisions = [...d.revisions, revision].slice(-30);
      d.excluded = draft.excluded;
      d.version++;
      d.updatedAt = new Date().toISOString();
      d.expiresAt = Date.now() + MONTH;
      resultVersion = d.version;
      ttl = MONTH;
      targetValue = JSON.stringify(draftSchema.parse(d));
      guards.push(...await activityWrites(d));
    }
    const terminal = runSchema.parse({
      ...storedRun,
      status: "ready",
      resultVersion,
    });
    signal.throwIfAborted();
    if (
      !(await store().batchCas([
        ...guards,
        { key: targetKey, old: targetRaw, value: targetValue, ttlMs: ttl },
        {
          key: `run:${run.id}`,
          old: runRaw,
          value: JSON.stringify(terminal),
          ttlMs: DAY,
        },
      ]))
    )
      throw conflict();
    await event("version_saved", "Your draft is ready.");
    // Unknown routing/reasoning charges retain the conservative reservation.
    actual = run.reservedUsd === 0 ? 0 : undefined;
    });
  } catch (e) {
    await withStoreDeadline(AbortSignal.timeout(2000), Date.now() + 2000, async () => {
    const state = await ownedRun(run.id, run.owner).catch(() => null);
    if (state?.status === "ready") return; // Commit succeeded; a later event-write failure cannot roll it back.
    const cancelled = controller.signal.aborted || state?.cancelled;
    const failure = qlooFailure(e);
    const error = cancelled
      ? "Stopped. Your draft is still here."
      : signal.aborted
        ? requestSignal?.aborted ? "The connection was interrupted." : "This is taking longer than it should. Your draft is safe."
        : failure.message;
    await update(
      `run:${run.id}`,
      runSchema,
      (r) => ({
        ...r!,
        status: cancelled ? ("cancelled" as const) : ("failed" as const),
        error,
        failure: { status: failure.status, ...(failure.retryAfter ? { resetAt: Date.now() + failure.retryAfter * 1000 } : {}) },
      }),
      DAY,
    );
    await event(cancelled ? "cancelled" : "failed", error);
    }).catch(() => {});
  } finally {
    clearInterval(poll);
    controllers.delete(run.id);
    const cleanupSignal = AbortSignal.timeout(2000);
    await withStoreDeadline(cleanupSignal, Date.now() + 2000, () => update(`run:${run.id}`, runSchema, (r) => ({
      ...r!, diagnostics: {
        policy: "bounded-selection-2" as const, latencyMs: Date.now() - (deadline - 45000),
        inputBounds: tools?.audit.inputBounds ?? [], steps: tools?.audit.steps ?? [],
        toolCalls: tools?.toolCalls ?? 0,
        cacheHits: [...(tools?.results.values() ?? [])].filter((s) => s.evidence.cache === "hit").length,
        reservedUsd: run.reservedUsd, settledUsd: actual ?? null,
      },
    }), DAY)).catch(() => {});
    await withStoreDeadline(AbortSignal.timeout(2000), Date.now() + 2000, () => settle(run.id, actual)).catch(() => {});
  }
}
export function publicRun(run: Run) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    events: run.events,
    error: run.error,
    failure: run.failure,
    partialSlots: run.partialSlots,
    resultVersion: run.resultVersion,
    attempts: run.attempts,
    model: run.model,
    diagnostics: run.diagnostics,
  };
}
