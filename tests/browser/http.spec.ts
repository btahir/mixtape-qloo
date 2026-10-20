import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, expect } from "@playwright/test";
test("production HTTP journey and capability separation", async ({
  playwright,
}) => {
  const root = "http://127.0.0.1:4319",
    a = await playwright.request.newContext({
      baseURL: root,
      extraHTTPHeaders: { Origin: root },
    }),
    b = await playwright.request.newContext({
      baseURL: root,
      extraHTTPHeaders: { Origin: root },
    }),
    c = await playwright.request.newContext({
      baseURL: root,
      extraHTTPHeaders: { Origin: root },
    });
  const anonymousDrafts = await c.get("/drafts");
  expect(anonymousDrafts.status()).toBe(200);
  expect(await anonymousDrafts.text()).toContain("No drafts yet.");
  const unknownDraft = await c.get("/make/missing-draft");
  expect(await unknownDraft.text()).toContain("This browser cannot edit that draft.");
  const created = await a.post("/api/drafts", {
    data: { source: "sample", sampleId: "quiet-evenings" },
  });
  expect(created.status(), await created.text()).toBe(200);
  let d = await created.json();
  expect(d.shelf).toHaveLength(9);
  const page = await a.get(`/make/${d.id}`);
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain("A mixtape for");
  expect((await c.get(`/api/drafts/${d.id}`)).status()).toBe(403);
  const runBody = {
    action: "prepare",
    draftId: d.id,
    expectedVersion: d.version,
    idempotencyKey: crypto.randomUUID(),
  };
  const prepareStarted = performance.now();
  const generated = await a.post("/api/agent", { data: runBody });
  expect(generated.status()).toBe(200);
  const stream = await generated.text();
  const prepareMs = performance.now() - prepareStarted;
  expect(stream).toContain("data-event");
  expect(stream).toContain("Your draft is ready.");
  expect(stream).not.toContain("reasoning");
  const replay = await a.post("/api/agent", { data: runBody });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).replay).toBe(true);
  d = await (await a.get(`/api/drafts/${d.id}`)).json();
  expect(d.revisions.at(-1).slots).toHaveLength(3);
  const shared = await a.post(`/api/drafts/${d.id}/shares`, {
    data: {
      expectedVersion: d.version,
      idempotencyKey: crypto.randomUUID(),
      repairEnabled: true,
      approvedIds: d.shelf.map((e: { entity: { id: string } }) => e.entity.id),
    },
  });
  expect(shared.status()).toBe(200);
  const link = await shared.json();
  const restoredLinks = await a.get(`/api/drafts/${d.id}/shares`);
  expect(restoredLinks.status()).toBe(200);
  expect((await restoredLinks.json()).links[0].path).toBe(link.path);
  expect((await b.get(`/api/drafts/${d.id}/shares`)).status()).toBe(403);
  expect(link.path).toMatch(/^\/m\//);
  const landing = await b.get(link.path);
  expect(landing.status()).toBe(200);
  expect(await landing.text()).toContain("Maya");
  expect(landing.headers()["referrer-policy"]).toBe("no-referrer");
  const bOpen = await b.post(`/api/receive/${link.token}/open`, { data: {} });
  expect(bOpen.status()).toBe(200);
  let gift = await bOpen.json();
  const original = gift.slots;
  expect(JSON.stringify(gift)).not.toContain("confirmedBySession");
  expect(JSON.stringify(gift)).not.toContain("pool");
  const reacted = await b.post(`/api/receipts/${gift.receiptId}/actions`, {
    data: { action: "known", slotId: "book", expectedVersion: gift.version },
  });
  expect(reacted.status()).toBe(200);
  gift = await reacted.json();
  const repairStarted = performance.now();
  const repaired = await b.post("/api/agent", {
    data: {
      action: "repair",
      receiptRef: gift.receiptId,
      slotId: "book",
      expectedVersion: gift.version,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(repaired.status()).toBe(200);
  expect(await repaired.text()).toContain("Your draft is ready.");
  const repairMs = performance.now() - repairStarted;
  gift = await (
    await b.post(`/api/receive/${link.token}/open`, { data: {} })
  ).json();
  expect(gift.slots[1].entity.id).not.toBe(original[1].entity.id);
  expect(gift.slots[0]).toEqual(original[0]);
  expect(gift.slots[2]).toEqual(original[2]);
  const forwarded = await (
    await c.post(`/api/receive/${link.token}/open`, { data: {} })
  ).json();
  expect(forwarded.slots).toEqual(original);
  expect(
    (
      await a.post(`/api/receipts/${gift.receiptId}/actions`, {
        data: { action: "save", slotId: "book", expectedVersion: gift.version },
      })
    ).status(),
  ).toBe(404);
  const back = await b.post("/api/drafts", {
    data: { source: "return", shareRef: link.token },
  });
  expect(back.status()).toBe(200);
  const returned = await back.json();
  expect(returned.sender).toBe("Leo");
  expect(returned.shelf).toHaveLength(0);
  expect(returned.tastes).toHaveLength(3);
  const revoked = await a.delete(`/api/shares/${link.id}`, { data: {} });
  expect(revoked.status()).toBe(200);
  expect(
    (await b.post(`/api/receive/${link.token}/open`, { data: {} })).status(),
  ).toBe(404);
  expect(
    (
      await a.post("/api/agent", { data: { ...runBody, messages: [] } })
    ).status(),
  ).toBe(400);
  expect(
    (
      await a.post("/api/drafts", {
        headers: { Origin: "https://other.test" },
        data: { source: "empty" },
      })
    ).status(),
  ).toBe(403);
  const comparison = await a.get("/compare/quiet-evenings");
  expect(await comparison.text()).toContain(
    "This comparison has not been run yet.",
  );
  const html = await (await a.get("/")).text();
  const scripts = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  const chunks = await Promise.all(
    scripts.map(async (path) => (await a.get(path)).body()),
  );
  console.log(
    "Landing JavaScript",
    JSON.stringify({
      scripts: scripts.length,
      uncompressedBytes: chunks.reduce((n, c) => n + c.length, 0),
      gzipBytes: chunks.reduce((n, c) => n + gzipSync(c).length, 0),
    }),
  );
  const measurements = {
    mode: "fixture",
    sampleSize: 1,
    prepareMs,
    repairMs,
    scripts: scripts.length,
    uncompressedBytes: chunks.reduce((n, c) => n + c.length, 0),
    gzipEstimateBytes: chunks.reduce((n, c) => n + gzipSync(c).length, 0),
    routes: await Promise.all([
      ["landing", html], ["composer", await page.text()], ["receiver", await landing.text()],
    ].map(async ([name, markup]) => {
      const paths = [...new Set([...markup.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js[^"]*)"[^>]*>/g)].filter((match) => !/\bnomodule\b/i.test(match[0])).map((match) => match[1]))];
      const bodies = await Promise.all(paths.map(async (path) => (await a.get(path)).body()));
      return { name, modernScripts: paths.length, uncompressedBytes: bodies.reduce((sum, body) => sum + body.length, 0), gzipEstimateBytes: bodies.reduce((sum, body) => sum + gzipSync(body).length, 0), containsZodRuntime: bodies.some((body) => /\bZodError\b|_zod/.test(body.toString())) };
    })),
  };
  console.log("Fixture HTTP measurements", JSON.stringify(measurements));
  if (process.env.MIXTAPE_SHOTS_DIR)
    await writeFile(
      join(process.env.MIXTAPE_SHOTS_DIR, "http-metrics.json"),
      JSON.stringify(measurements, null, 2),
    );
  await a.dispose();
  await b.dispose();
  await c.dispose();
});
