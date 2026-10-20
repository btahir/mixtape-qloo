import { openPieceOptions } from "./piece-options";
import { test, expect } from "./fixture";
import type { Draft, Gift } from "../../src/lib/domain";

test("failed run-status recovery blocks Make until latest status is resolved", async ({ page }) => {
  const d: Draft = await (await page.request.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
  await page.addInitScript(({ id }) => sessionStorage.setItem(`mixtape-run:${id}`, "unresolved-test-run"), { id: d.id });
  await page.route("**/api/runs/unresolved-test-run", (route) => route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }));
  await page.goto(`/make/${d.id}`);
  await expect(page.getByRole("button", { name: "Make their mixtape", exact: true })).toBeDisabled();
  const latest = page.getByRole("button", { name: "Check latest version", exact: true });
  await expect(latest).toBeVisible(); await latest.click();
  await expect(page.getByRole("button", { name: "Make their mixtape", exact: true })).toBeDisabled();
  await page.unroute("**/api/runs/unresolved-test-run");
  await latest.click(); // Absent/expired run is resolved by successfully reading current draft.
  await expect(page.getByRole("button", { name: "Make their mixtape", exact: true })).toBeEnabled();
  expect(await page.evaluate((id) => sessionStorage.getItem(`mixtape-run:${id}`), d.id)).toBeNull();
});

test("sample has one inventory per person and editing opens in place", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator("#tastes").getByText("Spirited Away", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Edit tastes", exact: true }).click();
  await expect(page.locator("#tastes").getByRole("combobox")).toBeFocused();
  await expect(page.locator("#tastes").getByText("Spirited Away", { exact: true })).toHaveCount(1);
});

test("search has a client deadline, retained query and an actionable alert", async ({ page }) => {
  test.setTimeout(25000);
  await page.goto("/"); await page.getByRole("button", { name: "Make a mixtape", exact: true }).click();
  await page.route("**/api/entities/search", () => {});
  const input = page.getByRole("combobox").first(); await input.fill("Before Sunrise");
  await expect(page.locator("#favourites").getByRole("alert")).toContainText("Search is unavailable right now.", { timeout: 15000 });
  await expect(input).toHaveValue("Before Sunrise");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
});

test("a slow preparation keeps Stop in the fixed action bar on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/"); await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await page.route("**/api/agent", () => {});
  await page.locator(".personal-details > summary").click();
  await page.getByLabel("A line from you").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  const stop = page.locator(".compose-actions").getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeInViewport(); await stop.click();
  await expect(page.locator(".recovery")).toContainText("Stopped. Your draft is still here.");
});

test("sender repair focuses the changed piece and announces its title", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  const book = page.locator('.panels > li[data-kind="book"]');
  await openPieceOptions(book);
  await book.getByRole("button", { name: "Try another", exact: true }).click();
  await expect(book.locator("article")).toBeFocused();
  await expect(page.locator(".result-toolbar")).toContainText("was replaced with");
});

test("typing during refresh recovery preserves words and leaves one usable recovery action", async ({ page }) => {
  const d: Draft = await (await page.request.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
  await page.addInitScript(({ id }) => sessionStorage.setItem(`mixtape-run:${id}`, "recover-after-typing"), { id: d.id });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/runs/recover-after-typing", async (route) => {
    await held;
    await route.fulfill({ status: 200, json: { id: "recover-after-typing", status: "ready", resultVersion: d.version + 1, events: [] } });
  });
  await page.goto(`/make/${d.id}`);
  await page.locator(".personal-details > summary").click();
  const line = page.getByLabel("A line from you");
  await line.fill("Words typed during recovery"); release();
  const latest = page.getByRole("button", { name: "Check latest version", exact: true });
  await expect(latest).toHaveCount(1); await expect(latest).toBeVisible();
  await expect(line).toHaveValue("Words typed during recovery");
  await expect(page.getByRole("button", { name: "Make their mixtape", exact: true })).toBeDisabled();
  await latest.click();
  await expect(page.getByRole("button", { name: "Make their mixtape", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Apply my words", exact: true })).toBeVisible();
});

test("refresh after an empty repair reloads its receipt version and blocks another unchanged repair", async ({ page }) => {
  let d: Draft = await (await page.request.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
  await page.request.post("/api/agent", { data: { action: "prepare", draftId: d.id, expectedVersion: d.version, idempotencyKey: crypto.randomUUID() } });
  d = await (await page.request.get(`/api/drafts/${d.id}`)).json();
  const share = await (await page.request.post(`/api/drafts/${d.id}/shares`, { data: { expectedVersion: d.version, repairEnabled: true, approvedIds: d.shelf.map((e) => e.entity.id), idempotencyKey: crypto.randomUUID() } })).json();
  const gift: Gift = await (await page.request.post(`/api/receive/${share.token}/open`, { data: {} })).json();
  const next: Gift = { ...gift, version: gift.version! + 1, blockedRepairs: ["book"] };
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, "empty-repair"), { key: `mixtape-receipt-run:${gift.id}:${gift.generation}` });
  await page.route("**/api/runs/empty-repair", (route) => route.fulfill({ status: 200, json: { id: "empty-repair", status: "needs_input", resultVersion: next.version, events: [] } }));
  await page.route(`**/api/receive/${share.token}/open`, (route) => route.fulfill({ status: 200, json: next }));
  let actionVersion: number | undefined, inferenceCalls = 0;
  await page.route(`**/api/receipts/${gift.receiptId}/actions`, (route) => {
    actionVersion = route.request().postDataJSON().expectedVersion;
    return route.fulfill({ status: 200, json: { ...next, known: [gift.slots.find((s) => s.kind === "book")!.entity.id] } });
  });
  await page.route("**/api/agent", (route) => { inferenceCalls++; return route.abort(); });
  await page.goto(share.path);
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), `mixtape-receipt-run:${gift.id}:${gift.generation}`)).toBeNull();
  await openPieceOptions(page.locator('.panels > li[data-kind="book"]'));
  await page.locator('.panels > li[data-kind="book"]').getByRole("button", { name: "Already know this", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(actionVersion).toBe(next.version);
  await expect(page.getByRole("button", { name: "Find another", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Keep this piece", exact: true })).toBeEnabled();
  expect(inferenceCalls).toBe(0);
});
