import { test, expect } from "./fixture";
import type { APIRequestContext } from "@playwright/test";
import type { Draft, Gift } from "../../src/lib/domain";
import type { PublicRun } from "../../src/lib/client";
async function generate(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post("/api/agent", { data: { ...data, idempotencyKey: crypto.randomUUID() } });
  expect(response.status()).toBe(200);
  const frames = (await response.text()).split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
  const run: PublicRun = frames.filter((frame) => frame.type === "data-run").at(-1).data;
  expect(run.status).toBe("ready"); return run;
}
test("sender recovers a committed run after receiving an older server snapshot", async ({ page }) => {
  const d: Draft = await (await page.request.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
  const path = `/make/${d.id}`, stale = await (await page.request.get(path)).text();
  const run = await generate(page.request, { action: "prepare", draftId: d.id, expectedVersion: d.version });
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), { key: `mixtape-run:${d.id}`, id: run.id });
  await page.route(`**${path}`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: stale }));
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "From Maya, for Leo", exact: true })).toBeVisible();
  await expect(page.locator(".panels > li")).toHaveCount(3);
});
test("recipient recovers a committed replacement after an older server snapshot", async ({ page }) => {
  let d: Draft = await (await page.request.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
  await generate(page.request, { action: "prepare", draftId: d.id, expectedVersion: d.version });
  d = await (await page.request.get(`/api/drafts/${d.id}`)).json();
  const share = await (await page.request.post(`/api/drafts/${d.id}/shares`, { data: { expectedVersion: d.version, repairEnabled: true, approvedIds: d.shelf.map((e) => e.entity.id), idempotencyKey: crypto.randomUUID() } })).json();
  let gift: Gift = await (await page.request.post(`/api/receive/${share.token}/open`, { data: {} })).json();
  gift = await (await page.request.post(`/api/receipts/${gift.receiptId}/actions`, { data: { action: "known", slotId: "book", expectedVersion: gift.version } })).json();
  const oldTitle = gift.slots.find((s) => s.kind === "book")!.entity.name;
  const stale = await (await page.request.get(share.path)).text();
  const run = await generate(page.request, { action: "repair", receiptRef: gift.receiptId, slotId: "book", expectedVersion: gift.version });
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), { key: `mixtape-receipt-run:${gift.id}:${gift.generation}`, id: run.id });
  await page.route(`**${share.path}`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: stale }));
  await page.goto(share.path);
  await expect(page.locator('.panels > li[data-kind="book"] h2')).not.toHaveText(oldTitle);
  await expect(page.locator(".panels > li")).toHaveCount(3);
});
