import { expect, it } from "vitest";
import { MemoryStore } from "@/lib/server/store";
import { acquire, acquireQloo, release, ledgerKey } from "@/lib/server/limits";

it("queues transport admission for a second visitor without exceeding two active Qloo leases", async () => {
  const storage = new MemoryStore();
  await acquire("qloo", "a", "visitor-one", storage);
  await acquire("qloo", "b", "visitor-one", storage);
  let admitted = false;
  const pending = acquireQloo("c", "visitor-two", AbortSignal.timeout(2000), storage).then(() => { admitted = true; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(admitted).toBe(false);
  await release("a", storage);
  await pending;
  const ledger = JSON.parse((await storage.get(ledgerKey))!);
  expect(Object.keys(ledger.leases).sort()).toEqual(["b", "c"]);
});
it("cancels a waiting visitor before transport or budget admission", async () => {
  const storage = new MemoryStore();
  await acquire("qloo", "a", "one", storage);
  await acquire("qloo", "b", "one", storage);
  const controller = new AbortController();
  const pending = acquireQloo("c", "two", controller.signal, storage);
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  const ledger = JSON.parse((await storage.get(ledgerKey))!);
  expect(Object.keys(ledger.leases).sort()).toEqual(["a", "b"]);
  expect(ledger.qlooTotal).toBe(0);
});
