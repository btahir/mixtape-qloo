import { test, expect } from "../browser/fixture";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";

const origin = "http://127.0.0.1:4321";
async function shot(page: Page, name: string) {
  const directory = process.env.MIXTAPE_SHOTS_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(directory, name + ".png"), animations: "disabled" });
}
async function runRecord(response: Response, page: Page) {
  const replay = await page.request.post("/api/agent", {
    data: response.request().postDataJSON(), headers: { Origin: origin },
  });
  const result = await replay.json();
  expect(result.replay).toBe(true);
  const run = await (await page.request.get(`/api/runs/${result.run.id}`)).json();
  expect(run.status).toBe("ready");
  expect(run.model).toBe("claude-haiku-5-5");
  expect(run.diagnostics.steps.length).toBeGreaterThan(0);
  return run;
}

for (const width of [1440, 390]) {
  test(`production judge journey at ${width}px with live Qloo and Haiku`, async ({ browser }) => {
    const owner = await browser.newContext({ baseURL: origin, viewport: { width, height: width === 1440 ? 900 : 844 }, extraHTTPHeaders: { "x-forwarded-for": width === 1440 ? "192.0.2.41" : "192.0.2.42" } });
    const reader = await browser.newContext({ baseURL: origin, viewport: { width, height: width === 1440 ? 900 : 844 }, extraHTTPHeaders: { "x-forwarded-for": width === 1440 ? "192.0.2.43" : "192.0.2.44" } });
    const page = await owner.newPage(), recipient = await reader.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    recipient.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(origin);
      await shot(page, `${width}-landing`);
      const initialResponse = page.waitForResponse((r) => r.url().endsWith("/api/agent") && r.request().method() === "POST");
      const start = Date.now();
      await page.getByRole("button", { name: "Open a sample gift", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Maya made you a mixtape.", exact: true })).toBeVisible();
      const initialMs = Date.now() - start;
      const initial = await runRecord(await initialResponse, page);
      await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
      await expect(page.locator(".panels > li")).toHaveCount(3);
      await page.getByRole("button", { name: "Make this yours / share", exact: true }).click();
      const draft = await (await page.request.get(`/api/drafts/${page.url().split("/").at(-1)}`)).json();
      expect(draft.mode).toBe("live");
      const slots = draft.revisions.at(-1).slots;
      expect(slots.every((s: { method: string; evidence: { score: number | null; cache: string } }) => s.method === "qloo" && s.evidence.score !== null)).toBe(true);
      const titles = await page.locator(".panels h2").allTextContents();
      await page.getByRole("button", { name: "Create share link", exact: true }).first().click();
      await page.getByRole("button", { name: "Create link", exact: true }).click();
      const link = page.getByLabel("Their link", { exact: true });
      await expect(link).toBeVisible();
      await recipient.goto(await link.inputValue());
      await expect(recipient.getByRole("heading", { name: "Maya made you a mixtape.", exact: true })).toBeVisible();
      await shot(recipient, `${width}-closed`);
      await recipient.getByRole("button", { name: "Open your mixtape", exact: true }).click();
      await expect(recipient.locator(".panels > li")).toHaveCount(3);
      await recipient.waitForTimeout(900);
      await shot(recipient, `${width}-gift`);
      const book = recipient.locator(".panels > li").nth(1);
      await book.locator(".piece-menu > summary").click();
      await book.getByRole("button", { name: "Already know this", exact: true }).click();
      const repairResponse = recipient.waitForResponse((r) => r.url().endsWith("/api/agent") && r.request().method() === "POST");
      const repairStart = Date.now();
      await recipient.getByRole("button", { name: "Find another", exact: true }).click();
      await expect(book.getByRole("heading")).not.toHaveText(titles[1]);
      const repairMs = Date.now() - repairStart;
      const repair = await runRecord(await repairResponse, recipient);
      expect(repair.attempts).toBeGreaterThan(0);
      const after = await recipient.locator(".panels h2").allTextContents();
      expect(after[0]).toBe(titles[0]);
      expect(after[2]).toBe(titles[2]);
      await book.getByRole("button", { name: "Why this?", exact: true }).click();
      await expect(recipient.getByRole("dialog")).toContainText("Qloo");
      await shot(recipient, `${width}-evidence`);
      await recipient.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await recipient.getByRole("button", { name: "Make one back", exact: true }).click();
      await expect(recipient.getByRole("heading", { name: "Now, one from you.", exact: true })).toBeVisible();
      await recipient.getByRole("button", { name: "Use selected favourites and continue", exact: true }).click();
      await expect(recipient.getByPlaceholder("Your first name")).toHaveValue("Leo");
      await shot(recipient, `${width}-return`);
      expect(errors).toEqual([]);
      if (process.env.MIXTAPE_SHOTS_DIR) await writeFile(join(process.env.MIXTAPE_SHOTS_DIR, `${width}-metrics.json`), JSON.stringify({ initialMs, repairMs, initial, repair, before: titles, after, errors }, null, 2));
    } finally {
      await owner.close();
      await reader.close();
    }
  });
}

test("all five saved comparisons are readable without new generation", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.45" } });
  try {
    const page = await context.newPage();
    for (const id of ["quiet-evenings", "a-little-more-soul", "stranger-worlds", "quiet-evenings-other-tastes", "known-low-coverage"]) {
      await page.goto(`${origin}/compare/${id}`);
      await expect(page.getByRole("heading", { name: "What changed with Qloo?", exact: true })).toBeVisible();
      await expect(page.getByText("This comparison has not been run yet.")).toHaveCount(0);
      await expect(page.locator(".comparison-pair")).toHaveCount(3);
      await page.getByText("Technical details", { exact: true }).click();
      await expect(page.locator(".comparison-technical")).toContainText("claude-haiku-5-5");
      await expect(page.locator(".comparison-technical")).toContainText("Source: live");
      if (id !== "known-low-coverage") await expect(page.getByText("Selection incomplete", { exact: true })).toHaveCount(0);
    }
  } finally { await context.close(); }
});
