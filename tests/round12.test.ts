import { beforeEach, expect, it, vi } from "vitest";
import { MemoryStore, read } from "@/lib/server/store";
import { createDraft, owned, ownedLinks, receiptAction, sampleReceipt, publicShare } from "@/lib/server/repository";
import { startRun, executeRun } from "@/lib/server/runs";
import { current, shareSchema, type Draft } from "@/lib/domain";
const owner = "owner-A";
const run = async (input: Parameters<typeof startRun>[0]) => {
  const start = await startRun(input, owner, "ip-A");
  await executeRun(start.run, start.draft!, () => {});
  return start.run.id;
};
async function prepared(): Promise<Draft> {
  const d = await createDraft(owner, "sample", "quiet-evenings");
  await run({ action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() });
  return owned(d.id, owner);
}
beforeEach(() => {
  (globalThis as typeof globalThis & { mixtapeStore: MemoryStore }).mixtapeStore = new MemoryStore();
  vi.unstubAllEnvs();
  vi.stubEnv("MIXTAPE_AGENT_MODE", "deterministic");
  vi.stubEnv("QLOO_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("TIFFIN_PROJECT", "");
});
it("opens a sample as a private receiving session without publishing a link", async () => {
  const d = await prepared();
  const gift = await sampleReceipt(d.id, owner);
  expect(gift.receiptId).toBeTruthy();
  expect(gift.repairEnabled).toBe(true);
  expect(gift.slots.map((s) => s.entity.id)).toEqual(current(d)!.slots.map((s) => s.entity.id));
  const share = await read(`share:${gift.id}`, shareSchema);
  expect(share?.tokenHashes).toEqual([]);
  const after = await owned(d.id, owner);
  expect(after.shareIds).toEqual([]);
  expect(after.shared).toEqual([]);
  expect(after.version).toBe(d.version);
  expect(await ownedLinks(d.id, owner)).toEqual([]);
  // Opening again returns the same receipt and keeps saved state.
  const saved = await receiptAction(gift.receiptId!, owner, { action: "save", slotId: "book", expectedVersion: gift.version! });
  const again = await sampleReceipt(d.id, owner);
  expect(again.receiptId).toBe(gift.receiptId);
  expect(again.saved).toEqual(saved.saved);
  await expect(sampleReceipt(d.id, "someone-else")).rejects.toMatchObject({ status: 403 });
});
it("refuses drafts that are not samples, and drafts without a gift yet", async () => {
  const empty = await createDraft(owner, "empty");
  await expect(sampleReceipt(empty.id, owner)).rejects.toMatchObject({ status: 400 });
  const unprepared = await createDraft(owner, "sample", "quiet-evenings");
  await expect(sampleReceipt(unprepared.id, owner)).rejects.toMatchObject({ status: 400 });
});
it("replaces a known sample piece through the real receipt repair and starts a return draft", async () => {
  const d = await prepared();
  const gift = await sampleReceipt(d.id, owner);
  const before = gift.slots.find((s) => s.kind === "book")!;
  const known = await receiptAction(gift.receiptId!, owner, { action: "known", slotId: "book", expectedVersion: gift.version! });
  await run({ action: "repair", receiptRef: gift.receiptId!, slotId: "book", expectedVersion: known.version!, idempotencyKey: crypto.randomUUID() });
  const repaired = await sampleReceipt(d.id, owner);
  const book = repaired.slots.find((s) => s.kind === "book")!;
  expect(book.entity.id).not.toBe(before.entity.id);
  expect(d.shelf.some((e) => e.entity.id === book.entity.id)).toBe(true);
  expect(repaired.slots.filter((s) => s.kind !== "book")).toEqual(gift.slots.filter((s) => s.kind !== "book"));
  expect(repaired.undoKind).toBe("book");
  const back = await createDraft(owner, "return", undefined, undefined, gift.receiptId);
  expect(back.sender).toBe(d.recipient);
  expect(back.recipient).toBe(d.sender);
  expect(back.tastes.map((e) => e.id)).toEqual(gift.slots.map((s) => s.entity.id));
  expect(back.returnCandidates?.map((e) => e.id)).toEqual(d.tastes.map((e) => e.id));
  await expect(createDraft("someone-else", "return", undefined, undefined, gift.receiptId)).rejects.toMatchObject({ status: 404 });
  await expect(publicShare("not-a-token")).rejects.toMatchObject({ status: 404 });
});
