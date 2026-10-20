import { beforeEach, describe, it, expect, vi } from "vitest";
import { MemoryStore, read, put, update, DAY } from "@/lib/server/store";
import { z } from "zod";
import {
  counter,
  reserve,
  settle,
  rate,
  qlooAttempt,
} from "@/lib/server/limits";
import {
  createDraft,
  owned,
  ownedLinks,
  saveDraft,
  createShare,
  publicShare,
  openReceipt,
  ownedReceipt,
  receiptAction,
  repairDraft,
  manageShare,
  deleteDraft,
  undoDraft,
} from "@/lib/server/repository";
import { startRun, executeRun, ownedRun, cancelRun } from "@/lib/server/runs";
import {
  current,
  draftSchema,
  shareSchema,
  giftProjection,
  validateCoverage,
} from "@/lib/domain";
import { SelectionTools, filterRanking } from "@/lib/agent/tools";
import { conservativeInputBound } from "@/lib/agent";
import {
  checkOrigin,
  body,
  verifyCookie,
  sign,
  hash,
} from "@/lib/server/security";
import { QlooClient, QLOO_ORIGIN } from "@/lib/qloo/client";
import type { Draft, Kind } from "@/lib/domain";
let memory: MemoryStore;
const owner = "owner-A";
const other = "reader-B";
const request = (draft: Draft, extras = {}) => ({
  action: "prepare" as const,
  draftId: draft.id,
  expectedVersion: draft.version,
  idempotencyKey: crypto.randomUUID(),
  ...extras,
});
async function prepared() {
  const d = await createDraft(owner, "sample", "quiet-evenings");
  const start = await startRun(request(d), owner, "ip-A");
  await executeRun(start.run, start.draft!, () => {});
  return owned(d.id, owner);
}
async function shared() {
  const d = await prepared();
  const result = await createShare(d.id, owner, {
    expectedVersion: d.version,
    idempotencyKey: crypto.randomUUID(),
    repairEnabled: true,
    approvedIds: d.shelf.map((e) => e.entity.id),
  });
  return { d, ...result };
}
beforeEach(() => {
  memory = new MemoryStore();
  (
    globalThis as typeof globalThis & { mixtapeStore: MemoryStore }
  ).mixtapeStore = memory;
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
  vi.stubEnv("QLOO_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("TIFFIN_PROJECT", "");
});
describe("atomic persistence and budgets", () => {
  it("CAS permits one winner, and mutations retry without losing increments", async () => {
    const wins = await Promise.all(
      Array.from({ length: 20 }, () => memory.cas("winner", null, "x", DAY)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
    const schema = z.object({ n: z.number() });
    await put("n", schema, { n: 0 }, DAY);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        update("n", schema, (v) => ({ n: (v?.n ?? 0) + 1 }), DAY),
      ),
    );
    expect(await read("n", schema)).toEqual({ n: 20 });
  });
  it("batch writes fail atomically when any version is wrong", async () => {
    await memory.cas("a", null, "1", DAY);
    expect(
      await memory.batchCas([
        { key: "a", old: "0", value: "2", ttlMs: DAY },
        { key: "b", old: null, value: "created", ttlMs: DAY },
      ]),
    ).toBe(false);
    expect(await memory.get("b")).toBeNull();
  });
  it("never crosses a rate limit under simultaneous callers", async () => {
    const runs = await Promise.allSettled(
      Array.from({ length: 15 }, () => counter("test", 3, 60000)),
    );
    expect(runs.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  });
  it("enforces IP allowance even with new sessions", async () => {
    for (let i = 0; i < 10; i++)
      await rate("inference", `session-${i}`, "one-IP");
    await expect(
      rate("inference", "new-session", "one-IP"),
    ).rejects.toMatchObject({ status: 429 });
  });
  it("has one lease per session across drafts and ten entry-wide", async () => {
    await reserve("r0", "same", false);
    await expect(reserve("r1", "same", false)).rejects.toMatchObject({
      status: 429,
    });
    for (let i = 1; i < 10; i++) await reserve(`r${i}`, `owner${i}`, false);
    await expect(reserve("r10", "owner10", false)).rejects.toMatchObject({
      status: 429,
    });
  });
  it("reserves once, retains unknown spend, and cannot refund twice", async () => {
    vi.stubEnv("MODEL_TOTAL_CAP_USD", "0.03");
    await reserve("paid", "a", true);
    await reserve("paid", "a", true);
    await settle("paid", undefined);
    await expect(reserve("paid2", "b", true)).rejects.toMatchObject({
      status: 503,
    });
    await settle("paid", 0.01);
    await settle("paid", 0);
    const l = JSON.parse((await memory.get("ledger:v1"))!);
    expect(l.total).toBeCloseTo(0.01);
  });
  it("caps concurrent spending at the last available reservation", async () => {
    vi.stubEnv("MODEL_TOTAL_CAP_USD", ".02");
    const a = await Promise.allSettled([
      reserve("a", "x", true),
      reserve("b", "y", true),
    ]);
    expect(a.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  });
  it("honors explicit access denial and counts dispatch attempts", async () => {
    vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "false");
    await expect(qlooAttempt()).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("QLOO_EVENT_ACCESS_CONFIRMED", "true");
    vi.stubEnv("QLOO_ACCESS_EXPIRES_AT", "2099-01-01T00:00:00Z");
    vi.stubEnv("QLOO_TOTAL_ATTEMPTS", "1");
    await qlooAttempt();
    await expect(qlooAttempt()).rejects.toMatchObject({ status: 503 });
  });
  it("denies inference on storage failure", async () => {
    (globalThis as typeof globalThis & { mixtapeStore: unknown }).mixtapeStore =
      {
        get: async () => {
          throw Error("private failure");
        },
      };
    await expect(counter("bad", 3, 60000)).rejects.toMatchObject({
      status: 503,
    });
  });
});
describe("grounded selection tools", () => {
  it("fixtures run entirely without network or model dispatch", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("must not call"));
    const d = await prepared();
    expect(current(d)?.slots).toHaveLength(3);
    for (const s of current(d)!.slots) {
      expect(d.shelf.some((e) => e.entity.id === s.entity.id)).toBe(true);
      expect(s.note).toBe(
        d.shelf.find((e) => e.entity.id === s.entity.id)!.note,
      );
      expect(s.evidence.score).toBeNull();
      expect(s.evidence.fetchedAt).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("initial coverage rejects duplicates, too few seeds and cross-mode records", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings");
    expect(() =>
      validateCoverage({ ...d, tastes: d.tastes.slice(0, 2) }),
    ).toThrow();
    expect(() =>
      validateCoverage({ ...d, shelf: [...d.shelf, d.shelf[0]] }),
    ).toThrow();
    expect(() => validateCoverage({ ...d, mode: "live" })).toThrow();
  });
  it("ignores wrong-kind/out-of-pool/excluded rows and keeps returned order and zero score", () => {
    const row = (id: string, kind = "movie") => ({
      entity_id: id,
      name: id,
      subtype: `urn:entity:${kind}`,
      query: { affinity: 0 },
    });
    const r = filterRanking(
      [row("bad"), row("b"), row("a"), row("c", "book"), row("b")],
      ["a", "b", "c"],
      "movie",
      ["a"],
    );
    expect(r.valid.map((e) => e.entity_id)).toEqual(["b"]);
    expect(r.valid[0].query?.affinity).toBe(0);
    expect(r.invalidCandidates).toEqual(["c"]);
  });
  it("repair changes one panel only and note is looked up by entity", async () => {
    const d = await prepared(),
      old = current(d)!;
    const start = await startRun(
      request(d, { action: "repair", slotId: "book" }),
      owner,
      "ip-A",
    );
    await executeRun(start.run, start.draft!, () => {});
    const next = await owned(d.id, owner);
    const after = current(next)!;
    expect(after.slots.find((s) => s.kind === "book")?.entity.id).not.toBe(
      old.slots.find((s) => s.kind === "book")?.entity.id,
    );
    expect(after.slots.filter((s) => s.kind !== "book")).toEqual(
      old.slots.filter((s) => s.kind !== "book"),
    );
    const undo = await undoDraft(d.id, owner, next.version);
    expect(current(undo)?.slots).toEqual(old.slots);
    expect(undo.excluded).toEqual(d.excluded);
  });
  it("valid empty requests input once and never repeats the same query", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings");
    d.mode = "live";
    const q = {
      insights: vi.fn().mockResolvedValue({
        data: { results: { entities: [] } },
        provenance: {
          source: "qloo",
          cache: "miss",
          fetchedAt: new Date().toISOString(),
        },
      }),
      getEntities: vi.fn(),
    };
    const t = new SelectionTools(
      d,
      q as never,
      new AbortController().signal,
      async () => {},
      async () => {},
    );
    const r = await t.rank("book", d.version);
    expect(r.status).toBe("empty");
    await expect(t.rank("book", d.version)).rejects.toThrow("identical");
    expect(q.insights).toHaveBeenCalledTimes(1);
  });
  it("only a genuinely removed invalid candidate allows one changed-subset retry", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings");
    d.mode = "live";
    const pool = d.shelf.filter((e) => e.entity.kind === "book");
    const q = {
      insights: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            results: {
              entities: [
                {
                  entity_id: pool[0].entity.id,
                  name: "bad",
                  subtype: "urn:entity:movie",
                },
              ],
            },
          },
          provenance: { cache: "miss", fetchedAt: "now" },
        })
        .mockResolvedValueOnce({
          data: {
            results: {
              entities: [
                {
                  entity_id: pool[1].entity.id,
                  name: "valid",
                  subtype: "urn:entity:book",
                },
              ],
            },
          },
          provenance: { cache: "miss", fetchedAt: "now" },
        }),
      getEntities: vi.fn(),
    };
    const t = new SelectionTools(
      d,
      q as never,
      new AbortController().signal,
      async () => {},
      async () => {},
    );
    expect((await t.rank("book", d.version)).retryAllowed).toBe(true);
    await t.rank("book", d.version);
    const queries = q.insights.mock.calls.map((c) => c[0]);
    expect(queries[0]["filter.results.entities"]).toHaveLength(3);
    expect(queries[1]["filter.results.entities"]).toHaveLength(2);
    expect(queries[1]["filter.results.entities"]).not.toContain(
      pool[0].entity.id,
    );
    expect(queries[0]["signal.interests.entities"]).toEqual(
      d.tastes.map((e) => e.id),
    );
  });
  it("unrelated invalid rows never justify identical corrective calls", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings");
    d.mode = "live";
    const q = {
      insights: vi.fn().mockResolvedValue({
        data: {
          results: {
            entities: [
              {
                entity_id: "outside",
                name: "outside",
                subtype: "urn:entity:movie",
              },
            ],
          },
        },
        provenance: { cache: "miss", fetchedAt: "now" },
      }),
      getEntities: vi.fn(),
    };
    const t = new SelectionTools(
      d,
      q as never,
      new AbortController().signal,
      async () => {},
      async () => {},
    );
    expect((await t.rank("book", d.version)).retryAllowed).toBe(false);
  });
  it("rejects arbitrary result references and cross-slot repairs", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings");
    const t = new SelectionTools(
      d,
      null,
      new AbortController().signal,
      async () => {},
      async () => {},
      "book",
    );
    await expect(t.rank("movie", 0)).rejects.toThrow();
    await expect(t.commit(["invented"])).rejects.toThrow();
  });
  it("model context byte bound grows with actual UTF-8 bytes", () => {
    expect(conservativeInputBound("é")).toBeGreaterThan(
      conservativeInputBound("a"),
    );
    expect(conservativeInputBound("x".repeat(8000))).toBeGreaterThan(8000);
  });
});
describe("run ownership, idempotency and failures", () => {
  it("same key replays while changed input conflicts", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings"),
      p = request(d);
    const a = await startRun(p, owner, "ip-A"),
      b = await startRun(p, owner, "ip-A");
    expect(b.replay).toBe(true);
    expect(b.run.id).toBe(a.run.id);
    await expect(
      startRun({ ...p, action: "refine" }, owner, "ip-A"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("stale draft input never starts inference", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings");
    await saveDraft(d.id, owner, { expectedVersion: 0, sender: "Changed" });
    await expect(startRun(request(d), owner, "ip-A")).rejects.toMatchObject({
      status: 409,
    });
  });
  it("cancelled runs cannot commit, preserving human inputs", async () => {
    const d = await createDraft(owner, "sample", "quiet-evenings"),
      s = await startRun(request(d), owner, "ip-A");
    await cancelRun(s.run.id, owner);
    await executeRun(s.run, s.draft!, () => {});
    expect((await ownedRun(s.run.id, owner)).status).toBe("cancelled");
    expect(await owned(d.id, owner)).toEqual(d);
  });
  it("kept pieces fail eligibility instead of bypassing known exclusions", async () => {
    const d = await prepared();
    const first = current(d)!.slots[0];
    await saveDraft(d.id, owner, {
      expectedVersion: d.version,
      lock: { kind: first.kind, locked: true },
    });
    const latest = await owned(d.id, owner);
    await update(
      `draft:${d.id}`,
      draftSchema,
      (v) => ({ ...v!, known: [first.entity.id] }),
      DAY,
    );
    const s = await startRun(request(latest), owner, "ip-A");
    await executeRun(s.run, s.draft!, () => {});
    expect((await ownedRun(s.run.id, owner)).status).toBe("failed");
    expect(current(await owned(d.id, owner))?.id).toBe(current(latest)?.id);
  });
});
describe("share and receipt capabilities", () => {
  it("freezes gift while projecting none of the unused shelf or owner powers", async () => {
    const { d, share, token } = await shared();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(share.tokenHashes).toEqual([hash(token)]);
    const gift = giftProjection(await publicShare(token));
    const serialized = JSON.stringify(gift);
    expect(serialized).not.toContain(owner);
    for (const e of d.shelf)
      if (!gift.slots.some((s) => s.entity.id === e.entity.id)) {
        expect(serialized).not.toContain(e.entity.id);
        expect(serialized).not.toContain(e.entity.name);
      }
    await expect(owned(d.id, other)).rejects.toMatchObject({ status: 403 });
  });
  it("share creation is idempotent and rejects a changed body", async () => {
    const d = await prepared();
    const p = {
      expectedVersion: d.version,
      idempotencyKey: crypto.randomUUID(),
      repairEnabled: true,
      approvedIds: d.shelf.map((e) => e.entity.id),
    };
    const a = await createShare(d.id, owner, p),
      b = await createShare(d.id, owner, p);
    expect(a.token).toBe(b.token);
    await expect(
      createShare(d.id, owner, { ...p, repairEnabled: false }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("sharing needs a human note on each selected entity", async () => {
    const d = await prepared();
    const slot = current(d)!.slots[0];
    const next = await saveDraft(d.id, owner, {
      expectedVersion: d.version,
      notes: { [slot.entity.id]: "" },
    });
    await expect(
      createShare(d.id, owner, {
        expectedVersion: next.version,
        idempotencyKey: crypto.randomUUID(),
        repairEnabled: true,
        approvedIds: d.shelf.map((e) => e.entity.id),
      }),
    ).rejects.toThrow("own note");
  });
  it("different readers have isolated reactions and repair overlays", async () => {
    const { d, share, token } = await shared();
    const b = await openReceipt(token, other),
      c = await openReceipt(token, "reader-C");
    expect(b.receiptId).not.toBe(c.receiptId);
    const reacted = await receiptAction(b.receiptId!, other, {
      action: "known",
      slotId: "book",
      expectedVersion: b.version!,
    });
    const { r, s } = await ownedReceipt(b.receiptId!, other);
    const rd = repairDraft(s, r);
    expect(rd.known).toContain(b.slots[1].entity.id);
    const input = {
      action: "repair" as const,
      receiptRef: b.receiptId,
      slotId: "book" as Kind,
      expectedVersion: reacted.version!,
      idempotencyKey: crypto.randomUUID(),
    };
    const run = await startRun(input, other, "ip-B");
    await executeRun(run.run, run.draft!, () => {});
    const after = await openReceipt(token, other);
    expect(after.slots[1].entity.id).not.toBe(b.slots[1].entity.id);
    expect(after.slots.filter((s) => s.kind !== "book")).toEqual(
      b.slots.filter((s) => s.kind !== "book"),
    );
    expect((await openReceipt(token, "reader-C")).slots).toEqual(c.slots);
    expect(current(await owned(d.id, owner))?.slots).toEqual(
      share.revision.slots,
    );
    await expect(ownedReceipt(b.receiptId!, owner)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("return starts an independent editable draft using only visible original choices", async () => {
    const { share, token } = await shared();
    const d = await createDraft(other, "return", undefined, token);
    expect(d.shelf).toEqual([]);
    expect(d.tastes).toEqual(share.revision.slots.map((s) => s.entity));
    expect(d.sender).toBe(share.recipient);
    expect(d.owner).toBe(other);
    expect(d.introduction).toBe("");
  });
  it("rotation and revocation deny every reader without changing their private state", async () => {
    const { share, token } = await shared();
    const b = await openReceipt(token, other);
    const rotated = await manageShare(share.id, owner, true);
    await expect(publicShare(token)).rejects.toMatchObject({ status: 404 });
    expect("token" in rotated).toBe(true);
    await manageShare(share.id, owner);
    await expect(ownedReceipt(b.receiptId!, other)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("expiry and sender deletion invalidate links", async () => {
    const { d, share, token } = await shared();
    await update(
      `share:${share.id}`,
      shareSchema,
      (s) => ({ ...s!, expiresAt: Date.now() - 1 }),
      DAY,
    );
    await expect(publicShare(token)).rejects.toMatchObject({ status: 404 });
    const next = await owned(d.id, owner);
    await deleteDraft(d.id, owner, next.version);
    await expect(owned(d.id, owner)).rejects.toThrow();
  });
});
describe("request boundary", () => {
  it("requires same-origin and rejects untrusted extra fields via schemas", () => {
    expect(() =>
      checkOrigin(
        new Request("https://mixtape.test/api", {
          headers: { origin: "https://evil.test" },
        }),
      ),
    ).toThrow();
    expect(() =>
      checkOrigin(
        new Request("https://mixtape.test/api", {
          headers: { origin: "https://mixtape.test" },
        }),
      ),
    ).not.toThrow();
  });
  it("caps streamed bodies and rejects malformed JSON", async () => {
    await expect(
      body(
        new Request("https://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "x".repeat(16385),
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      body(
        new Request("https://local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{bad",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("verifies a signed expiry and refuses tampered cookies", () => {
    const value = `random-session.${Date.now() + 10000}`;
    expect(verifyCookie(`${value}.${sign(value)}`)).toBe("random-session");
    expect(verifyCookie(`${value}.tampered`)).toBeNull();
  });
  it("turns malformed upstream envelopes into an error instead of an empty success", async () => {
    const q = new QlooClient({
      origin: QLOO_ORIGIN,
      apiKey: "test-only-placeholder",
      transport: {
        mode: "live",
        fetch: async () => Response.json({ results: {} }),
      },
      maxAttempts: 1,
    });
    await expect(
      q.insights({
        "filter.type": "urn:entity:book",
        "signal.interests.entities": ["a0000000-0000-4000-8000-000000000001"],
      }),
    ).rejects.toMatchObject({ kind: "contract" });
  });
});

describe("immutable snapshots and stale evidence", () => {
  it("does not create a revision for an unchanged autosave", async () => {
    const d = await prepared();
    const before = d.revisions.length;
    const next = await saveDraft(d.id, owner, {
      expectedVersion: d.version,
      notes: Object.fromEntries(d.shelf.map((e) => [e.entity.id, e.note])),
    });
    expect(next.revisions.length).toBe(before);
    expect(current(next)).toEqual(current(d));
  });
  it("changing tastes marks evidence stale without changing older revisions", async () => {
    const d = await prepared(),
      snapshot = structuredClone(current(d));
    const next = await saveDraft(d.id, owner, {
      expectedVersion: d.version,
      remove: { list: "tastes", id: d.tastes[0].id },
    });
    expect(next.revisions[0]).toEqual(snapshot);
    expect(current(next)?.slots.every((s) => s.previousTastes)).toBe(true);
    await expect(
      createShare(d.id, owner, {
        expectedVersion: next.version,
        idempotencyKey: crypto.randomUUID(),
        repairEnabled: false,
        approvedIds: [],
      }),
    ).rejects.toThrow("Update their mixtape");
  });
  it("undoing a new reaction keeps the already repaired revision", async () => {
    const { token } = await shared();
    let g = await openReceipt(token, other);
    g = await receiptAction(g.receiptId!, other, {
      action: "known",
      slotId: "book",
      expectedVersion: g.version!,
    });
    const s = await startRun(
      {
        action: "repair",
        receiptRef: g.receiptId!,
        slotId: "book",
        expectedVersion: g.version!,
        idempotencyKey: crypto.randomUUID(),
      },
      other,
      "ip-B",
    );
    await executeRun(s.run, s.draft!, () => {});
    g = await openReceipt(token, other);
    const repaired = g.slots[1].entity.id;
    g = await receiptAction(g.receiptId!, other, {
      action: "decline",
      slotId: "book",
      expectedVersion: g.version!,
    });
    g = await receiptAction(g.receiptId!, other, {
      action: "undo",
      slotId: "book",
      expectedVersion: g.version!,
    });
    expect(g.slots[1].entity.id).toBe(repaired);
    expect(g.declined).not.toContain(repaired);
  });
});

describe("owner link recovery", () => {
  it("reopens active original links without exposing the pool or granting reader access", async () => {
    const { d, share, token } = await shared();
    expect(await ownedLinks(d.id, owner)).toEqual([
      { id: share.id, path: `/m/${token}`, expiresAt: share.expiresAt },
    ]);
    await expect(ownedLinks(d.id, other)).rejects.toThrow(
      "This browser cannot edit that draft.",
    );
    expect(JSON.stringify(await ownedLinks(d.id, owner))).not.toContain("pool");
    const rotated = await manageShare(share.id, owner, true);
    expect(rotated).toHaveProperty("token");
    expect((await ownedLinks(d.id, owner))[0].path).toBe(`/m/${rotated.token}`);
    await expect(publicShare(token)).rejects.toThrow();
    await manageShare(share.id, owner);
    expect(await ownedLinks(d.id, owner)).toEqual([]);
  });
});

it("keeps validated partial choices separate from the last committed revision", async () => {
  const d = await createDraft(owner, "sample", "quiet-evenings");
  d.mode = "live";
  const film = d.shelf.find((e) => e.entity.kind === "movie")!.entity;
  const q = {
    insights: vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          results: {
            entities: [
              {
                entity_id: film.id,
                name: film.name,
                subtype: "urn:entity:movie",
              },
            ],
          },
        },
        provenance: { cache: "miss", fetchedAt: new Date().toISOString() },
      })
      .mockResolvedValueOnce({
        data: { results: { entities: [] } },
        provenance: { cache: "miss", fetchedAt: new Date().toISOString() },
      }),
    getEntities: vi.fn(),
  };
  const t = new SelectionTools(
    d,
    q as never,
    new AbortController().signal,
    async () => {},
    async () => {},
  );
  await t.rank("movie", d.version);
  const empty = await t.rank("book", d.version);
  expect(empty.status).toBe("empty");
  await t.requestInput("book", "no_supported_result");
  expect([...t.results.values()].map((s) => s.entity.id)).toEqual([film.id]);
  expect(t.committed).toBe(false);
  expect(current(await owned(d.id, owner))).toBeUndefined();
  expect(q.insights).toHaveBeenCalledTimes(2);
});

it("opens the immutable gift read-only when receipt admission is closed", async () => {
  const gift = await shared();
  const write = memory.cas.bind(memory);
  vi.spyOn(memory, "cas").mockImplementation(async (key, ...args) => {
    if (key.startsWith("receipt")) throw new Error("Durable storage admission closed");
    return write(key, ...args);
  });
  const opened = await openReceipt(gift.token!, other);
  expect(opened.receiptId).toBeUndefined();
  expect(opened.slots.map((slot) => slot.entity.id)).toEqual(current(gift.d)!.slots.map((slot) => slot.entity.id));
});
