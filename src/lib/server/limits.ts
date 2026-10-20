import "server-only";
import { z } from "zod";
import { DAY, update, store, type Store } from "./store";
import { AppError } from "./errors";
import { sleep } from "../qloo/client";
const countSchema = z.object({ count: z.number(), reset: z.number() });
export async function counter(
  key: string,
  max: number,
  windowMs: number,
  s: Store = store(),
  now = Date.now(),
) {
  const v = await update(
    `limit:${key}`,
    countSchema,
    (old) => {
      const n =
        old && old.reset > now ? old : { count: 0, reset: now + windowMs };
      if (n.count >= max)
        throw new AppError(
          429,
          "You have made a few mixtapes quickly. Try again later.",
          Math.ceil((n.reset - now) / 1000),
        );
      return { ...n, count: n.count + 1 };
    },
    windowMs + 1000,
    s,
  );
  return v;
}
const policies = {
  inference: [
    [3, 60000],
    [20, DAY],
    [10, 60000],
    [60, DAY],
  ],
  search: [
    [12, 60000],
    [60, DAY],
    [30, 60000],
    [200, DAY],
  ],
  write: [
    [30, 60000],
    [60, 60000],
  ],
  create: [[20, DAY], [60, DAY]],
  share: [
    [10, DAY],
    [30, DAY],
  ],
  read: [[120, 60000]],
  poll: [[60, 60000], [120, 60000]],
  cancel: [[12, 60000], [30, 60000]],
} as const;
export async function rate(
  kind: keyof typeof policies,
  session: string,
  ip: string,
  s: Store = store(),
) {
  const rules = policies[kind];
  for (let i = 0; i < rules.length; i++) {
    const [max, window] = rules[i];
    const byIp =
      kind === "read" ||
      (["write", "share", "poll", "cancel", "create"].includes(kind) ? i === 1 : i >= 2);
    await counter(`${kind}:${i}:${byIp ? ip : session}`, max, window, s);
  }
}
const ledgerSchema = z.object({
  day: z.string(),
  daily: z.number(),
  total: z.number(),
  qlooDaily: z.number(),
  qlooTotal: z.number(),
  qlooResetApplied: z.string().optional(),
  reservations: z.record(
    z.string(),
    z.object({ amount: z.number(), settled: z.boolean(), until: z.number().optional() }),
  ),
  leases: z.record(
    z.string(),
    z.object({
      owner: z.string(),
      until: z.number(),
      kind: z.enum(["run", "qloo", "search"]),
    }),
  ),
});
export const ledgerKey = "ledger:v1";
const initial = (): z.infer<typeof ledgerSchema> => ({
  day: "",
  daily: 0,
  total: 0,
  qlooDaily: 0,
  qlooTotal: 0,
  reservations: {},
  leases: {},
});
function refresh(old: z.infer<typeof ledgerSchema> | null, now: number) {
  const l = old ?? initial();
  const day = new Date(now).toISOString().slice(0, 10);
  if (l.day !== day) {
    l.day = day;
    l.daily = 0;
    l.qlooDaily = 0;
  }
  for (const [id, reservation] of Object.entries(l.reservations))
    if (reservation.settled || (reservation.until !== undefined && reservation.until <= now)) delete l.reservations[id];
  for (const [k, v] of Object.entries(l.leases))
    if (v.until <= now) delete l.leases[k];
  return l;
}
const cap = (key: string, fallback: number) => {
  const n = Number(process.env[key]?.trim() || fallback);
  if (!Number.isFinite(n) || n < 0)
    throw new AppError(
      503,
      "New mixtapes are paused for now. Saved links still work.",
    );
  return Math.min(n, fallback);
};
export async function reserve(
  id: string,
  owner: string,
  paid: boolean,
  s: Store = store(),
  now = Date.now(),
) {
  if (process.env.PAUSE_GENERATION === "true")
    throw new AppError(
      503,
      "New mixtapes are paused for now. Saved links still work.",
    );
  const markerKey = `reservation:${id}`;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await s.get(markerKey)) return;
    const raw = await s.get(ledgerKey);
    const l = refresh(raw ? ledgerSchema.parse(JSON.parse(raw)) : null, now);

    const active = Object.values(l.leases).filter((v) => v.kind === "run");
    if (active.length >= 10 || active.some((v) => v.owner === owner))
      throw new AppError(
        429,
        "Mixtape is busy right now. Your draft is saved.",
        5,
      );
    const amount = paid ? 0.02 : 0;
    if (
      l.daily + amount > cap("MODEL_DAILY_CAP_USD", 3) ||
      l.total + amount > cap("MODEL_TOTAL_CAP_USD", 25)
    )
      throw new AppError(
        503,
        "New mixtapes are paused for now. Saved links still work.",
      );
    l.daily += amount;
    l.total += amount;
    if (paid) l.reservations[id] = { amount, settled: false, until: now + DAY };
    l.leases[id] = { owner, until: now + 50000, kind: "run" };
    if (await s.batchCas([
      { key: ledgerKey, old: raw, value: JSON.stringify(l), ttlMs: 365 * DAY },
      { key: markerKey, old: null, value: "reserved", ttlMs: DAY },
    ])) return;
  }
  throw new AppError(409, "This mixtape is already starting. Check latest version.");
}
export async function settle(
  id: string,
  actual: number | undefined,
  s: Store = store(),
) {
  await update(
    ledgerKey,
    ledgerSchema,
    (old) => {
      const l = refresh(old, Date.now());
      const r = l.reservations[id];
      delete l.leases[id];
      if (!r || r.settled || actual === undefined) return l;
      if (actual < 0 || actual > r.amount)
        throw new AppError(503, "Model usage exceeded the reserved policy.");
      l.total -= r.amount - actual;
      if (id.startsWith(l.day)) l.daily -= r.amount - actual;
      delete l.reservations[id];
      return l;
    },
    365 * DAY,
    s,
  );
}
export async function acquire(
  kind: "qloo" | "search",
  id: string,
  owner: string,
  s: Store = store(),
) {
  await update(
    ledgerKey,
    ledgerSchema,
    (old) => {
      const l = refresh(old, Date.now());
      const active = Object.values(l.leases).filter((x) => x.kind === kind);
      if (
        active.length >= 2 ||
        (kind === "search" &&
          active.filter((x) => x.owner === owner).length >= 2)
      )
        throw new AppError(
          429,
          "Mixtape is busy right now. Your draft is saved.",
          2,
        );
      l.leases[id] = { owner, until: Date.now() + 13000, kind };
      return l;
    },
    365 * DAY,
    s,
  );
}
/** Wait for transport capacity inside the caller's existing request deadline. */
export async function acquireQloo(id: string, owner: string, signal: AbortSignal, s: Store = store()) {
  const deadline = Date.now() + 6000;
  while (true) {
    signal.throwIfAborted();
    try { await acquire("qloo", id, owner, s); return; }
    catch (error) {
      if (!(error instanceof AppError) || error.status !== 429 || Date.now() >= deadline) throw error;
      await sleep(80, signal);
    }
  }
}
export async function release(id: string, s: Store = store()) {
  await update(
    ledgerKey,
    ledgerSchema,
    (old) => {
      const l = refresh(old, Date.now());
      delete l.leases[id];
      return l;
    },
    365 * DAY,
    s,
  );
}
export const quotaSchema = z.object({
  daily: z.number().int().min(0).max(250), total: z.number().int().min(0).max(2500),
  resetAt: z.string().datetime(), accessExpiresAt: z.string().datetime(),
});
export function quotaDefaults() {
  return quotaSchema.parse({
    daily: Number(process.env.QLOO_DAILY_ATTEMPTS?.trim() || 150),
    total: Number(process.env.QLOO_TOTAL_ATTEMPTS?.trim() || 2500),
    resetAt: process.env.QLOO_QUOTA_RESET_AT?.trim() || "2026-11-18T00:00:00Z",
    accessExpiresAt: new Date(process.env.QLOO_ACCESS_EXPIRES_AT?.trim() || "2026-11-30T23:59:59Z").toISOString(),
  });
}
/** Create-only: a deploy must never replenish usage or replace an allocation. */
export async function provisionAllowance(s: Store = store()) {
  await s.cas("allowance:v1", null, JSON.stringify(quotaDefaults()), 365 * DAY);
  await s.cas(ledgerKey, null, JSON.stringify(initial()), 365 * DAY);
}
export function ensureQlooAccess() {
  let expiry = 0;
  try { expiry = Date.parse(quotaDefaults().accessExpiresAt); }
  catch { throw new AppError(503, "New choices are unavailable right now. You can still open saved mixtapes."); }
  if (process.env.QLOO_EVENT_ACCESS_CONFIRMED === "false" ||
      process.env.QLOO_ALLOCATION_CONFIRMED === "false" || expiry <= Date.now())
    throw new AppError(503, "We cannot reach Qloo with this setup.");
}
export async function qlooAttempt(s: Store = store()) {
  ensureQlooAccess();
  const defaults = quotaDefaults();
  const raw = await s.get("allowance:v1");
  const allowance = raw ? quotaSchema.parse(JSON.parse(raw)) : defaults;
  if (Date.parse(allowance.accessExpiresAt) <= Date.now()) throw new AppError(503, "We cannot reach Qloo with this setup.");
  await update(
    ledgerKey,
    ledgerSchema,
    (old) => {
      const l = refresh(old, Date.now());
      // One scheduled total-allowance reset, applied on use, never by a deploy.
      if (Date.parse(allowance.resetAt) <= Date.now() && l.qlooResetApplied !== allowance.resetAt) {
        l.qlooTotal = 0;
        l.qlooResetApplied = allowance.resetAt;
      }
      if (l.qlooDaily >= Math.min(defaults.daily, allowance.daily) ||
          l.qlooTotal >= Math.min(defaults.total, allowance.total))
        throw new AppError(503, "New choices are unavailable right now. You can still open saved mixtapes.");
      l.qlooDaily++;
      l.qlooTotal++;
      return l;
    },
    365 * DAY,
    s,
  );
}
