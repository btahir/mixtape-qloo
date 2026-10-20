import { openPieceOptions } from "./piece-options";
import { test, expect } from "./fixture";
import type { Page, Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
async function capture(page: Page, name: string, focus?: string) {
  if (!process.env.MIXTAPE_SHOTS_DIR) return;
  await mkdir(process.env.MIXTAPE_SHOTS_DIR, { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (focus) await page.locator(focus).first().evaluate((element) => element.scrollIntoView({ block: "start" }));
    else if (!(await page.getByRole("dialog").count())) await page.evaluate(() => scrollTo(0, 0));
    else await page.getByRole("dialog").locator(".sheet-header").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(process.env.MIXTAPE_SHOTS_DIR, `${name}-${viewport.width}x${viewport.height}.png`), animations: "disabled" });
  }
}
async function prepare(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
}
async function share(page: Page) {
  await prepare(page);
  await page.getByRole("button", { name: "Create share link", exact: true }).first().click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  return page.getByLabel("Their link", { exact: true }).inputValue();
}
test("search active-descendant, option semantics, targets and keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Make a mixtape", exact: true }).click();
  const input = page.getByRole("combobox").first();
  await input.press("ArrowUp");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.fill("Before");
  const option = page.getByRole("option");
  await expect(option).toHaveCount(1);
  await expect.poll(async () => {
    const row = (await option.boundingBox())!;
    const footer = (await page.locator(".compose-actions").boundingBox())!;
    return row.y + row.height <= footer.y;
  }).toBe(true);
  expect(await option.locator("button, input, a, [tabindex='0']").count()).toBe(0);
  await input.press("ArrowDown");
  await input.press("Escape");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.fill("Before Sunrise");
  await expect(option).toHaveCount(1);
  await input.press("ArrowDown"); await input.press("Enter");
  await expect(page.getByText("1 favourites · 6 needed, 12 maximum", { exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  for (const width of [360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const link of await page.locator(".site-header a, .site-header button").all()) {
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});
test("two tabs reapply only dirty human fields after loading latest", async ({ page, context }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "A mixtape for Leo", exact: true })).toBeVisible();
  const stale = await context.newPage(); await stale.goto(page.url());
  await page.locator(".personal-details > summary").click();
  await page.getByPlaceholder("Your first name").fill("Newer sender");
  await page.getByPlaceholder("Your first name").blur();
  await expect(page.locator(".action-save-status")).toHaveText("Draft saved");
  await stale.locator(".personal-details > summary").click();
  await stale.getByPlaceholder("What made you want to send this?").fill("Only my line changed");
  await stale.getByPlaceholder("What made you want to send this?").blur();
  await expect(stale.locator(".recovery")).toContainText("This draft changed in another tab.");
  await stale.getByRole("button", { name: "Load the latest version", exact: true }).click();
  await expect(stale.getByPlaceholder("Your first name")).toHaveValue("Newer sender");
  await stale.getByRole("button", { name: "Apply my words", exact: true }).click();
  await expect(stale.getByPlaceholder("Your first name")).toHaveValue("Newer sender");
  await expect(stale.getByPlaceholder("What made you want to send this?")).toHaveValue("Only my line changed");
  await stale.getByRole("button", { name: "Try saving again", exact: true }).click();
  await stale.reload();
  await expect(stale.getByPlaceholder("Your first name")).toHaveValue("Newer sender");
  await expect(stale.getByPlaceholder("What made you want to send this?")).toHaveValue("Only my line changed");
});
test("undo only follows a replacement and preserves freshly saved notes; pending format describes committed slots", async ({ page }) => {
  await prepare(page);
  await expect(page.getByRole("heading", { name: "From Maya, for Leo", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Undo replacement", exact: true })).toHaveCount(0);
  const film = page.locator(".panels > li").first();
  await openPieceOptions(film);
  await film.locator(".note-editor-trigger").click();
  await page.getByRole("dialog").locator("textarea").fill("My newly written human note"); await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(film.locator(".human-note")).toHaveText("My newly written human note");
  await expect(page.getByRole("button", { name: "Undo replacement", exact: true })).toHaveCount(0);
  const book = page.locator(".panels > li").nth(1);
  const title = await book.getByRole("heading").innerText();
  await openPieceOptions(book);
  await book.getByRole("button", { name: "Try another", exact: true }).click();
  await expect(book.getByRole("heading")).not.toHaveText(title);
  await openPieceOptions(page);
  await page.getByRole("button", { name: "Undo replacement", exact: true }).click();
  await expect(book.getByRole("heading")).toHaveText(title);
  await expect(film.locator(".human-note")).toHaveText("My newly written human note");
  await film.locator(".note-editor-trigger").click();
  await expect(page.getByRole("dialog").locator("textarea")).toHaveValue("My newly written human note");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Preview opening", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to editing", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Back to editing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Preview opening", exact: true })).toBeFocused();
  await page.locator(".edition-menu > summary").click();
  await page.getByRole("button", { name: "Edit tastes", exact: true }).click();
  await page.locator(".format-details > summary").click();
  await page.getByLabel("An artist", { exact: true }).uncheck();
  await expect(page.getByText("Three of your favourites, chosen for them.", { exact: true })).toBeVisible();
  await capture(page, "pending-format");
});
test("share sheet keeps close and creation visible; recipient repair reconciles inside its modal", async ({ page, browser }) => {
  const url = await share(page);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": "192.0.2.89" } });
  const recipient = await context.newPage(); await recipient.goto(url);
  await recipient.getByRole("button", { name: "Open your mixtape", exact: true }).click();
  await expect(recipient.getByRole("heading", { name: "From Maya, for Leo", exact: true })).toBeFocused();
  const book = recipient.locator(".panels > li").nth(1);
  const oldTitle = await book.getByRole("heading").innerText();
    await openPieceOptions(book);
  await book.getByRole("button", { name: "Already know this", exact: true }).click();
  await recipient.route("**/api/agent", async (route) => {
    const response = await route.fetch(); const body = await response.text();
    const first = body.split("\n\n").find((block) => block.includes('"type":"data-run"'))!;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: first + "\n\n" });
  });
  await recipient.getByRole("button", { name: "Find another", exact: true }).click();
  const dialog = recipient.getByRole("dialog");
  await expect(dialog).toContainText("The connection was interrupted.");
  await expect(dialog.getByRole("button", { name: "Find another", exact: true })).toBeDisabled();
  await capture(recipient, "repair-interrupted");
  await dialog.getByRole("button", { name: "Check latest version", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(book.getByRole("heading")).not.toHaveText(oldTitle);
  await expect(book.locator("article")).toBeFocused();
  await openPieceOptions(book);
  await book.getByRole("button", { name: "Save this", exact: true }).click();
  await expect(book.getByRole("button", { name: "Saved", exact: true })).toBeFocused();
  await recipient.getByRole("button", { name: "Your saved pieces", exact: true }).click();
  await expect(recipient.locator(".saved-collection .eyebrow")).toHaveText("book");
  await capture(recipient, "saved-book");
  await context.close();
});
test("all nine sample film covers fit their print rectangle at five widths", async ({ browser }) => {
  test.setTimeout(90000);
  const titles = new Set<string>();
  for (let sample = 0; sample < 3; sample++) {
    const context = await browser.newContext({ reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": `192.0.2.${91 + sample}` } });
    const page = await context.newPage(); await page.goto("/");
    await page.getByRole("button", { name: "Try this exchange", exact: true }).nth(sample).click();
    await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
    const film = page.locator('.panels > li[data-kind="movie"]');
    for (let replacement = 0; replacement < 3; replacement++) {
      await expect(film).toBeVisible();
      const title = await film.getByRole("heading").innerText(); titles.add(title);
      for (const width of [360, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await page.evaluate(() => document.fonts.ready);
        await expect.poll(async () => film.locator(".cover-title").evaluate((element) => element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      if (title.includes("Eternal Sunshine")) { await page.evaluate(() => scrollTo(0, 0)); await capture(page, "long-title"); }
      if (replacement < 2) {
        await openPieceOptions(film);
  await film.getByRole("button", { name: "Try another", exact: true }).click();
        await expect(film.getByRole("heading")).not.toHaveText(title);
      }
    }
    await context.close();
  }
  expect(titles.size).toBe(9);
});
test("recipient cooldowns prevent repeated dispatch", async ({ page }) => {
  const url = await share(page);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(url); await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
  const book = page.locator('.panels > li[data-kind="book"]');
    await openPieceOptions(book);
  await book.getByRole("button", { name: "Already know this", exact: true }).click();
  let calls = 0;
  await page.route("**/api/agent", (route) => { calls++; return route.fulfill({ status: 429, json: { error: "Qloo needs a short pause. Try again later.", resetAt: Date.now() + 1500 } }); });
  const find = page.getByRole("button", { name: "Find another", exact: true });
  await find.click(); await expect(find).toBeDisabled(); expect(calls).toBe(1);
  await capture(page, "repair-cooldown");
  await expect(find).toBeEnabled({ timeout: 5000 });
});
test("stalled transport ends at the client deadline and retains the composer", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/"); await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  let held: Route | undefined;
  await page.route("**/api/agent", (route) => { held = route; });
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choosing from your shelf", exact: true })).toBeVisible();
  await expect(page.locator(".recovery")).toContainText("This is taking longer than it should. Your draft is safe.", { timeout: 47000 });
  await expect(page.getByRole("heading", { name: "Choosing from your shelf", exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Your first name")).toBeEnabled();
  await held?.abort().catch(() => {});
  await capture(page, "client-deadline");
});
test("search preserves server cooldown without automatically repeating the query", async ({ page }) => {
  await page.goto("/"); await page.getByRole("button", { name: "Make a mixtape", exact: true }).click();
  let calls = 0;
  await page.route("**/api/entities/search", (route) => { calls++; return route.fulfill({ status: 429, json: { error: "You have made a few mixtapes quickly. Try again later.", resetAt: Date.now() + 1500 } }); });
  const search = page.locator(".entity-search").first();
  await search.getByRole("combobox").fill("Before");
  const retry = search.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeDisabled(); expect(calls).toBe(1);
  await capture(page, "search-cooldown", ".entity-search");
  await expect(retry).toBeEnabled({ timeout: 5000 }); expect(calls).toBe(1);
});
test("read quota produces a temporary retry page, not a dead-link claim", async ({ page, browser }) => {
  const url = await share(page);
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.97" } });
  for (let i = 0; i < 120; i++) await context.request.get(url);
  const recipient = await context.newPage(); await recipient.goto(url);
  await expect(recipient.getByRole("heading", { name: "We cannot open this mixtape right now.", exact: true })).toBeVisible();
  await expect(recipient.getByRole("heading", { name: "This mixtape is no longer available.", exact: true })).toHaveCount(0);
  await capture(recipient, "read-cooldown");
  await context.close();
});
