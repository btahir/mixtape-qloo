import { test, expect } from "../browser/fixture";
import { mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { current, eligibility, type Draft } from "../../src/lib/domain";
import { createCacheKey } from "../../src/lib/qloo/cache";
import { DiskCache } from "../../src/lib/qloo/disk-cache";

const cacheDirectory = process.env.QLOO_DEV_CACHE_DIR ?? ".qa/qloo-cache";

test("live publication survives repair, re-share and rotation without repeating history", async ({ playwright }) => {
  const root = "http://127.0.0.1:4320";
  const owner = await playwright.request.newContext({ baseURL: root, extraHTTPHeaders: { Origin: root, "x-forwarded-for": "192.0.2.151" } });
  const reader = await playwright.request.newContext({ baseURL: root, extraHTTPHeaders: { Origin: root, "x-forwarded-for": "192.0.2.152" } });
  try {
    let d: Draft = await (await owner.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
    expect(d.mode).toBe("live");
    const run = async (action: "prepare" | "repair") => {
      const response = await owner.post("/api/agent", { data: { action, draftId: d.id, ...(action === "repair" ? { slotId: "book" } : {}), expectedVersion: d.version, idempotencyKey: crypto.randomUUID() } });
      expect(response.status()).toBe(200); expect(await response.text()).toContain('"status":"ready"');
      d = await (await owner.get(`/api/drafts/${d.id}`)).json();
    };
    const share = async () => {
      const response = await owner.post(`/api/drafts/${d.id}/shares`, { data: { expectedVersion: d.version, repairEnabled: true, approvedIds: d.shelf.map((e) => e.entity.id), idempotencyKey: crypto.randomUUID() } });
      expect(response.status(), await response.text()).toBe(200);
      d = await (await owner.get(`/api/drafts/${d.id}`)).json();
      return response.json();
    };
    await run("prepare"); const original = current(d)!.slots, first = await share();
    await run("repair"); const repaired = current(d)!.slots, second = await share();
    expect(repaired[1].entity.id).not.toBe(original[1].entity.id);
    expect(repaired.filter((s) => s.kind !== "book")).toEqual(original.filter((s) => s.kind !== "book"));
    const gift = await (await reader.post(`/api/receive/${first.token}/open`, { data: {} })).json(); expect(gift.slots).toEqual(original);
    const oldReceipt = await (await reader.post(`/api/receive/${second.token}/open`, { data: {} })).json();
    const rotated = await owner.post(`/api/shares/${second.id}/rotate`, { data: {} });
    expect(rotated.status()).toBe(200); const next = await rotated.json(); const nextPath = `/m/${next.token}`;
    const links = await (await owner.get(`/api/drafts/${d.id}/shares`)).json();
    expect(links.links.find((link: { id: string }) => link.id === second.id).path).toBe(nextPath);
    expect((await reader.post(`/api/receive/${second.token}/open`, { data: {} })).ok()).toBe(false);
    expect((await reader.post(`/api/receipts/${oldReceipt.receiptId}/actions`, { data: { action: "save", slotId: "book", expectedVersion: oldReceipt.version } })).status()).toBe(404);
    expect((await reader.post("/api/agent", { data: { action: "repair", receiptRef: oldReceipt.receiptId, slotId: "book", expectedVersion: oldReceipt.version, idempotencyKey: crypto.randomUUID() } })).status()).toBe(404);
    const replacementReceipt = await (await reader.post(`/api/receive/${next.token}/open`, { data: {} })).json();
    expect(replacementReceipt.generation).toBe(oldReceipt.generation + 1);
    expect(replacementReceipt.receiptId).not.toBe(oldReceipt.receiptId);
    expect((await reader.get(nextPath)).status()).toBe(200);
    const repeat = await owner.post("/api/drafts", { data: { source: "repeat", shareRef: d.id } });
    expect(repeat.status()).toBe(200);
    const repeated: Draft = await repeat.json(); expect(repeated.shared).toHaveLength(4);
    expect(repeated.shared).toEqual(expect.arrayContaining(original.map((s) => s.entity.id)));
    await metrics("live-publication", { mode: d.mode, immutableOriginal: true, repairedOnlyBook: true, rotatedLinkRecoverable: true, oldReceiptActionsDenied: true, oldReceiptInferenceDenied: true, replacementReceiptGeneration: replacementReceipt.generation, repeatedHistoryCount: repeated.shared.length });
  } finally { await owner.dispose(); await reader.dispose(); }
});

async function shot(page: Page, name: string, fullPage = false) {
  if (!process.env.MIXTAPE_SHOTS_DIR) return;
  await mkdir(process.env.MIXTAPE_SHOTS_DIR, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  // Cover art is optional: the printed fallback is already visible while loading.
  for (const art of await page.locator(".entity-art-wrap:visible").all()) await art.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-art-state="loading"]:visible')).toHaveCount(0, { timeout: 15000 });
  if (name === "search") await page.locator("#tastes").evaluate((el) => el.scrollIntoView({ block: "start" }));
  else if (!(await page.getByRole("dialog").count())) await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const size = page.viewportSize()!;
  await page.screenshot({ path: join(process.env.MIXTAPE_SHOTS_DIR, `live-${name}-${size.width}x${size.height}${fullPage ? "-full" : ""}.png`), fullPage, animations: "disabled" });
}
async function metrics(name: string, value: unknown) {
  if (process.env.MIXTAPE_SHOTS_DIR) await writeFile(join(process.env.MIXTAPE_SHOTS_DIR, name + ".json"), JSON.stringify(value, null, 2));
}
test("20 live sample runs and an uncached primary book replacement", async ({ playwright }) => {
  test.skip(!process.env.QLOO_DEV_CACHE_DIR, "The cache audit requires an explicit local development cache.");
  test.setTimeout(120000);
  const rows: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    const context = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4320", extraHTTPHeaders: { Origin: "http://127.0.0.1:4320", "x-forwarded-for": `203.0.113.${100 + i}` } });
    let draft: Draft = await (await context.post("/api/drafts", { data: { source: "sample", sampleId: ["quiet-evenings", "a-little-more-soul", "stranger-worlds"][i % 3] } })).json();
    expect(draft.mode).toBe("live");
    const started = Date.now();
    const prepared = await context.post("/api/agent", { data: { action: "prepare", draftId: draft.id, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() } });
    expect(await prepared.text()).toContain('"status":"ready"');
    const initialMs = Date.now() - started;
    draft = await (await context.get(`/api/drafts/${draft.id}`)).json();
    const before = current(draft)!.slots;
    if (i === 0) {
      const copy = structuredClone(draft), book = before.find((s) => s.kind === "book")!;
      copy.excluded.push(book.entity.id);
      const otherIds = before.filter((s) => s.kind !== "book").map((s) => s.entity.id);
      const candidates = eligibility(copy, "book", otherIds);
      const deny = [...new Set([...copy.tastes.map((s) => s.id), ...copy.known, ...copy.shared, ...copy.excluded, ...otherIds])];
      const key = createCacheKey("https://hackathon.api.qloo.com", "GET:private-development:live", "/v2/insights", {
        "filter.type": "urn:entity:book", "signal.interests.entities": copy.tastes.map((e) => e.id),
        "filter.results.entities": candidates.map((e) => e.entity.id), "filter.exclude.entities": deny,
        "feature.explainability": true, take: candidates.length, sort_by: "affinity",
      }, "entityInsights");
      const cache = new DiskCache(cacheDirectory);
      await cache.delete(key); expect(await cache.get(key)).toBeUndefined();
    }
    const attemptCount = async () => (await readFile(join(cacheDirectory, "attempts.ndjson"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const attemptsBefore = await attemptCount(), repairStarted = Date.now();
    const repaired = await context.post("/api/agent", { data: { action: "repair", slotId: "book", draftId: draft.id, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() } });
    expect(await repaired.text()).toContain('"status":"ready"');
    const repairMs = Date.now() - repairStarted;
    draft = await (await context.get(`/api/drafts/${draft.id}`)).json();
    const after = current(draft)!.slots, book = after.find((s) => s.kind === "book")!;
    expect(book.entity.id).not.toBe(before.find((s) => s.kind === "book")!.entity.id);
    expect(after.filter((s) => s.kind !== "book")).toEqual(before.filter((s) => s.kind !== "book"));
    const calls = await attemptCount() - attemptsBefore;
    if (i === 0) { expect(book.evidence.cache).toBe("miss"); expect(calls).toBeGreaterThan(0); }
    rows.push({ sample: draft.sampleId, initialMs, repairMs, initialCache: before.map((s) => s.evidence.cache), repairCache: book.evidence.cache, calls });
    await context.dispose();
  }
  await metrics("live-latency-20", rows);
});
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`live judge minute, private repair and editable return at ${viewport.width}`, async ({ browser }) => {
    test.setTimeout(90000);
    const owner = await browser.newContext({ viewport, extraHTTPHeaders: { "x-forwarded-for": `192.0.2.${viewport.width === 1440 ? 91 : 92}` } });
    const page = await owner.newPage(), errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/"); await shot(page, "landing");
    await expect(page.getByText("Sample mode · No live Qloo calls", { exact: true })).toHaveCount(0);
    const started = Date.now();
    await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
    await expect(page.getByText("9 favourites · 6 needed, 12 maximum", { exact: true })).toBeAttached();
    const overview = page.getByRole("region", { name: "Composer" });
    await expect(overview.getByRole("heading", { name: "Leo’s tastes", exact: true })).toBeVisible();
    await expect(overview).toContainText("The Little Prince");
    await expect(overview).toContainText("Maya’s favourites");
    await expect(page.getByRole("button", { name: "Make their mixtape", exact: true })).toHaveCount(1);
    await shot(page, "composer"); await shot(page, "composer", true);
    const generation = Date.now();
    const initialResponse = page.waitForResponse((r) => r.url().endsWith("/api/agent") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
    await expect(page.getByRole("heading", { name: "From Maya, for Leo", exact: true })).toBeVisible();
    const initialMs = Date.now() - generation;
    const recordRun = async (response: import("@playwright/test").Response, client: Page) => {
      // The successful UI refresh can evict Chromium's response body. Recover
      // diagnostics using the same idempotency key; assert this admits no new run.
      const body = await response.text().catch(() => null);
      const records = (body ?? "").split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
      let run = records.filter((entry) => entry.type === "data-run").map((entry) => entry.data).at(-1);
      if (!run) {
        const replay = await client.request.post("/api/agent", { data: response.request().postDataJSON(), headers: { Origin: new URL(client.url()).origin } });
        const recovered = await replay.json(); expect(recovered.replay).toBe(true); run = recovered.run;
      }
      const saved = await (await client.request.get(`/api/runs/${run.id}`)).json();
      if (process.env.MIXTAPE_SHOTS_DIR) await appendFile(join(process.env.MIXTAPE_SHOTS_DIR, "model-runs.ndjson"), JSON.stringify(saved) + "\n");
      return saved;
    };
    const initialRun = await recordRun(await initialResponse, page);
    const draftId = page.url().split("/").at(-1)!;
    const d: Draft = await (await page.request.get(`/api/drafts/${draftId}`)).json();
    const slots = d.revisions.at(-1)!.slots;
    expect(d.mode).toBe("live"); expect(slots.every((s) => s.method === "qloo" && s.evidence.score !== null && s.evidence.contributions?.length)).toBe(true);
    await shot(page, "result"); await shot(page, "result", true);
    if (viewport.width === 390) expect(await page.locator(".entity-art-wrap").first().evaluate((el) => el.getBoundingClientRect().height)).toBe(156);
    await page.getByRole("button", { name: "Create share link", exact: true }).first().click(); await shot(page, "share-review");
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect(page.getByLabel("Their link", { exact: true })).toBeVisible(); await shot(page, "share-created");
    const url = await page.getByLabel("Their link", { exact: true }).inputValue();
    const reader = await browser.newContext({ viewport, extraHTTPHeaders: { "x-forwarded-for": `192.0.2.${viewport.width === 1440 ? 93 : 94}` } });
    const recipient = await reader.newPage(); recipient.on("pageerror", (e) => errors.push(e.message));
    await recipient.goto(url); await expect(recipient.getByRole("heading", { name: "Maya made you a mixtape.", exact: true })).toBeVisible(); await shot(recipient, "receive-closed");
    if (viewport.width === 390) {
      const note = await recipient.locator(".letter").boundingBox(), parcel = await recipient.locator(".object-stage").boundingBox(), open = await recipient.getByRole("button", { name: "Open your mixtape", exact: true }).boundingBox();
      expect(note!.y + note!.height).toBeLessThanOrEqual(parcel!.y);
      expect(open!.y + open!.height).toBeLessThan(viewport.height);
      expect(open!.y).toBeLessThan(parcel!.y);
    }
    await recipient.getByRole("button", { name: "Open your mixtape", exact: true }).click();
    await expect(recipient.locator(".panels > li")).toHaveCount(3); await shot(recipient, "receive-open");
    const firstSave = recipient.locator(".panels > li").first().getByRole("button", { name: "Save this", exact: true });
    if (viewport.width === 390) {
      await expect(recipient.locator(".gift-contents")).toBeInViewport();
      await firstSave.scrollIntoViewIfNeeded();
    }
    await expect(firstSave).toBeInViewport();
    const saveWidth = (await firstSave.boundingBox())!.width;
    await firstSave.click();
    const saved = recipient.locator(".panels > li").first().getByRole("button", { name: "Saved", exact: true });
    await expect(saved).toHaveAttribute("aria-pressed", "true");
    expect((await saved.boundingBox())!.width).toBe(saveWidth);
    const destination = recipient.locator(".explore-piece").first();
    await expect(destination).toBeVisible();
    expect((await destination.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const before = await recipient.locator(".panels h2").allTextContents(), book = recipient.locator('.panels > li[data-kind="book"]');
    await book.getByRole("button", { name: "Save this", exact: true }).click();
    await book.locator(".reaction-menu > summary").click();
    await book.getByRole("button", { name: "Already know this", exact: true }).click(); await shot(recipient, "repair-review");
    const repairStarted = Date.now();
    const repairResponse = recipient.waitForResponse((r) => r.url().endsWith("/api/agent") && r.request().method() === "POST");
    await recipient.getByRole("button", { name: "Find another", exact: true }).click();
    const repairRun = await recordRun(await repairResponse, recipient);
    expect(repairRun.status, JSON.stringify(repairRun)).toBe("ready");
    await expect(book.getByRole("heading")).not.toHaveText(before[1]);
    const repairMs = Date.now() - repairStarted;
    const after = await recipient.locator(".panels h2").allTextContents(); expect(after[0]).toBe(before[0]); expect(after[2]).toBe(before[2]);
    await recipient.getByRole("button", { name: "Your saved pieces", exact: true }).click();
    await expect(recipient.locator(".saved-collection")).toContainText(before[1]);
    await shot(recipient, "saved-original");
    await recipient.getByRole("button", { name: "Show all pieces", exact: true }).click();
    await shot(recipient, "replaced"); await book.getByRole("button", { name: "Why this?", exact: true }).click();
    await expect(recipient.getByRole("dialog")).toContainText("Reported connections"); await expect(recipient.locator(".contribution-list li")).not.toHaveCount(0);
    await expect(recipient.locator(".evidence-request")).not.toHaveAttribute("open", "");
    await expect(recipient.getByRole("dialog")).toContainText("Qloo reported connections to");
    await expect(recipient.locator(".contribution-list")).not.toBeVisible();
    await expect(recipient.getByRole("dialog")).not.toContainText("Illustrative sample"); await shot(recipient, "evidence");
    await recipient.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await recipient.getByRole("button", { name: "Make one back", exact: true }).click();
    await expect(recipient.getByRole("heading", { name: "Now, one from you.", exact: true })).toBeVisible();
    const minuteMs = Date.now() - started; expect(minuteMs).toBeLessThan(60000); await shot(recipient, "return");
    await recipient.getByRole("button", { name: "Use selected favourites and continue", exact: true }).click();
    await expect(recipient.getByPlaceholder("Your first name")).toHaveValue("Leo"); await shot(recipient, "return-composer"); await shot(recipient, "return-composer", true);
    await page.goto("/compare/quiet-evenings"); await expect(page.getByText("This comparison has not been run yet.")).toHaveCount(0);
    await expect(page.getByText(/Live Qloo ranking versus/)).toBeVisible(); await shot(page, "comparison"); await shot(page, "comparison", true);
    await expect(page.locator(".comparison-pair")).toHaveCount(3);
    await expect(page.locator(".comparison-technical")).not.toHaveAttribute("open", "");
    // Public read-only view includes the failed low-coverage case, not just successful examples.
    await page.goto("/compare/known-low-coverage"); await expect(page.getByText("The frozen constraints need more eligible favourites.").first()).toBeVisible(); await shot(page, "comparison-low-coverage");
    if (process.env.MIXTAPE_SHOTS_DIR) await writeFile(join(process.env.MIXTAPE_SHOTS_DIR, `live-metrics-${viewport.width}.json`), JSON.stringify({ initialRun, repairRun, initialMs, repairMs, minuteMs, includesScreenshotOverhead: true, initialCache: slots.map((s) => s.evidence.cache), errors }, null, 2));
    expect(errors).toEqual([]); await reader.close(); await owner.close();
  });
}

test("all three live samples, confirmed edited taste, and image failure fallback", async ({ browser }) => {
  test.setTimeout(120000);
  let context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "192.0.2.97" } });
  let page = await context.newPage();
  for (let i = 0; i < 3; i++) {
    await page.goto("/");
    await page.getByRole("button", { name: "Try this exchange", exact: true }).nth(i).click();
    await expect(page.getByPlaceholder("Your first name")).not.toHaveValue("");
    await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
    await expect(page.locator(".panels > li")).toHaveCount(3);
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) { await page.setViewportSize(size); await shot(page, `sample-${i + 1}`); }
  }
  await context.close();
  // A separate participant edits their own tastes; retain the real three-runs/minute limit.
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "192.0.2.98" } });
  page = await context.newPage();
  await page.goto("/"); await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
  await page.locator(".edition-menu > summary").click();
  await page.getByRole("button", { name: "Edit tastes", exact: true }).click();
  await page.getByRole("button", { name: "Remove The Little Prince", exact: true }).click();
  const tastes = page.locator("#tastes");
  await tastes.getByRole("button", { name: "Books", exact: true }).click();
  await tastes.getByRole("combobox").fill("Piranesi");
  const option = page.getByRole("option").filter({ hasText: "Susanna Clarke" }).first();
  await expect(option).toBeVisible();
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) { await page.setViewportSize(size); await shot(page, "search"); }
  await option.click();
  await expect(page.getByText("3 of 5 tastes", { exact: true })).toBeAttached();
  await page.getByRole("button", { name: "Update their mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
  await expect(page.locator(".choice-change")).toContainText("Piranesi");
  const changed: Draft = await (await page.request.get(`/api/drafts/${page.url().split("/").at(-1)}`)).json();
  expect(current(changed)!.slots.map((s) => s.entity.name)).not.toEqual(["Amélie", "Invisible Cities", "Khruangbin"]);
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) { await page.setViewportSize(size); await shot(page, "edited-tastes"); }
  await shot(page, "edited-tastes", true);
  await context.route("https://**/*", (route) => route.request().resourceType() === "image" ? route.abort() : route.continue());
  await page.reload();
  for (const art of await page.locator(".entity-art-wrap:visible").all()) await art.scrollIntoViewIfNeeded();
  await expect(page.locator('.entity-art-wrap[data-art-state="fallback"]')).toHaveCount(3);
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) { await page.setViewportSize(size); await shot(page, "image-fallback"); }
  await context.close();
});

test("live API confirms an edited taste and changes the resulting gift", async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4320", extraHTTPHeaders: { Origin: "http://127.0.0.1:4320", "x-forwarded-for": "192.0.2.99" } });
  let draft: Draft = await (await request.post("/api/drafts", { data: { source: "sample", sampleId: "quiet-evenings" } })).json();
  const old = draft.tastes.find((e) => e.name === "The Little Prince")!;
  draft = await (await request.patch(`/api/drafts/${draft.id}`, { data: { expectedVersion: draft.version, remove: { list: "tastes", id: old.id } } })).json();
  const search = await request.post("/api/entities/search", { data: { query: "Piranesi", kind: "book", draftId: draft.id } });
  expect(search.status()).toBe(200);
  const results: { entity: { name: string; detail: string }; resultRef: string }[] = (await search.json()).results;
  const selected = results.find((r) => r.entity.name === "Piranesi" && r.entity.detail.includes("Susanna Clarke"))!;
  expect(selected).toBeDefined();
  draft = await (await request.post(`/api/drafts/${draft.id}/confirm-entity`, { data: { expectedVersion: draft.version, resultRef: selected.resultRef, list: "tastes" } })).json();
  expect(draft.tastes.map((e) => e.name)).toEqual(["Spirited Away", "Bon Iver", "Piranesi"]);
  const response = await request.post("/api/agent", { data: { action: "prepare", draftId: draft.id, expectedVersion: draft.version, idempotencyKey: crypto.randomUUID() } });
  expect(await response.text()).toContain('"status":"ready"');
  draft = await (await request.get(`/api/drafts/${draft.id}`)).json();
  const choices = current(draft)!.slots;
  expect(choices.map((s) => s.entity.name)).not.toEqual(["Amélie", "Invisible Cities", "Khruangbin"]);
  expect(choices.every((s) => s.evidence.signals.some((e) => e.name === "Piranesi"))).toBe(true);
  await metrics("live-edited-taste-api", { choices: choices.map((s) => s.entity.name), source: draft.mode, cache: choices.map((s) => s.evidence.cache) });
  await request.dispose();
});

test("one changed taste shows the two saved live outcomes without inference", async ({ page }) => {
  let inference = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/agent")) inference++; });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/connections");
    await expect(page.locator(".taste-swap")).toContainText("The Little Prince");
    await expect(page.locator(".taste-swap")).toContainText("Piranesi");
    await expect(page.locator('.connection-outcomes [data-changed="true"]')).toHaveCount(2);
    await expect(page.locator('.connection-outcomes [data-changed="false"]')).toContainText("Amélie");
    await expect(page.getByText(/No model ran in these saved comparisons/)).toBeVisible();
    await shot(page, "one-taste"); await shot(page, "one-taste", true);
  }
  expect(inference).toBe(0);
});
