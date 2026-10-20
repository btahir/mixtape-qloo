import { openPieceOptions } from "./piece-options";
import { test, expect } from "./fixture";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
async function capture(page: Page, name: string) {
  if (!process.env.MIXTAPE_SHOTS_DIR) return;
  await mkdir(process.env.MIXTAPE_SHOTS_DIR, { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await page.evaluate(() => document.fonts.ready);
    if (name === "preflight-pending") await page.locator(".run-status").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(process.env.MIXTAPE_SHOTS_DIR, `${name}-${size.width}x${size.height}.png`), animations: "disabled" });
  }
}
async function sample(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await expect(page.getByPlaceholder("Your first name")).toHaveValue("Maya");
  await page.locator(".personal-details > summary").click();
}
async function prepare(page: Page) {
  await sample(page);
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
}
test("failed text save survives identity confirmation and later retry", async ({ page }) => {
  await sample(page);
  const line = page.getByPlaceholder("What made you want to send this?");
  await page.route("**/api/drafts/*", (route) => route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { error: "Your latest edits are not saved yet." } }) : route.continue());
  await line.fill("UNSAVED HUMAN WORDS"); await line.blur();
  await expect(page.locator(".action-save-status")).toHaveText("Your latest edits are not saved yet.");
  await page.getByRole("button", { name: "Edit favourites", exact: true }).click();
  const search = page.getByRole("combobox").first();
  await search.fill("The Apartment");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("ArrowDown"); await search.press("Enter");
  await expect(page.getByText("10 favourites · 6 needed, 12 maximum", { exact: true })).toBeVisible();
  await expect(line).toHaveValue("UNSAVED HUMAN WORDS");
  await expect(page.locator(".action-save-status")).toHaveText("Your latest edits are not saved yet.");
  await capture(page, "unsaved-confirmation");
  await page.unroute("**/api/drafts/*");
  await page.getByRole("button", { name: "Try saving again", exact: true }).click();
  await expect(page.locator(".action-save-status")).toHaveText("Draft saved");
  await page.reload(); await expect(line).toHaveValue("UNSAVED HUMAN WORDS");
});
test("focused text and format autosave without blur; starter recovers after Back", async ({ page }) => {
  await sample(page);
  await page.getByPlaceholder("What made you want to send this?").fill("Saved while I keep typing here");
  await expect(page.locator(".action-save-status")).toHaveText("Draft saved");
  await page.reload();
  await expect(page.getByPlaceholder("What made you want to send this?")).toHaveValue("Saved while I keep typing here");
  await page.locator(".format-details > summary").click();
  await page.getByLabel("An artist", { exact: true }).uncheck();
  await expect(page.locator(".action-save-status")).toHaveText("Draft saved");
  await page.reload(); await expect(page.getByLabel("An artist", { exact: true })).not.toBeChecked();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Try this exchange", exact: true }).first()).toBeEnabled();
});
test("forward keyboard reaches generation and expanded focus stays above action bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await sample(page);
  await page.getByRole("button", { name: "Edit favourites", exact: true }).click();
  await page.locator(".shelf-inventory > summary").click();
  await page.getByPlaceholder("Your first name").focus();
  let reached = false;
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      const bar = document.querySelector(".compose-actions")!.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      return { primary: active.textContent === "Make their mixtape", covered: !!active.closest(".composer-inputs") && rect.bottom > bar.top };
    });
    if (result.covered) await expect.poll(async () => page.evaluate(() => document.activeElement!.getBoundingClientRect().bottom <= document.querySelector(".compose-actions")!.getBoundingClientRect().top)).toBe(true);
    if (result.primary) { reached = true; break; }
  }
  expect(reached).toBe(true); await page.keyboard.press("Enter");
  await expect(page.locator(".panels > li")).toHaveCount(3);
});
test("preflight save can be stopped; sender repair observes cooldown at all entry points", async ({ page }) => {
  await sample(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/drafts/*", async (route) => { if (route.request().method() === "PATCH") { await held; await route.abort().catch(() => {}); } else await route.continue(); });
  await page.getByPlaceholder("What made you want to send this?").fill("Pending words");
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, "preflight-pending");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".recovery")).toContainText("Stopped. Your draft is still here.");
  release(); await page.unroute("**/api/drafts/*");
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
  let calls = 0;
  await page.route("**/api/agent", (route) => { calls++; return route.fulfill({ status: 429, json: { error: "Qloo needs a short pause. Try again later.", resetAt: Date.now() + 60000 } }); });
  await openPieceOptions(page);
  await page.getByRole("button", { name: "Try another", exact: true }).first().click();
  await expect(page.locator(".recovery")).toContainText("Qloo needs a short pause");
  await capture(page, "sender-cooldown");
  for (const button of await page.getByRole("button", { name: "Try another", exact: true }).all()) await expect(button).toBeDisabled();
  expect(calls).toBe(1);
});
test("share success and missing notes retain useful focus; long names fit", async ({ page }) => {
  await prepare(page);
  const first = page.locator(".panels > li").first();
  await openPieceOptions(first);
  await first.locator(".note-editor-trigger").click(); await page.getByRole("dialog").locator("textarea").fill(""); await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("Draft saved");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add 1 note", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await capture(page, "missing-note-action");
  await expect(page.getByRole("dialog").locator("textarea")).toBeFocused();
  await page.getByRole("dialog").locator("textarea").fill("Words of my own"); await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".save-status")).toHaveText("Draft saved");
  await page.getByRole("button", { name: "Create share link", exact: true }).first().click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByLabel("Their link", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator(".edition-menu > summary").click();
  await page.getByRole("button", { name: "Edit tastes", exact: true }).click();
  for (const placeholder of ["Your first name", "Their first name"]) await page.getByPlaceholder(placeholder).fill("W".repeat(40));
  await page.getByPlaceholder("Their first name").blur();
  await expect(page.locator(".action-save-status")).toHaveText("Draft saved");
  await page.getByRole("button", { name: "Preview opening", exact: true }).click();
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => Array.from(document.querySelectorAll("main *")).filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => ({ tag: el.tagName, class: el.className, right: Math.round(el.getBoundingClientRect().right) })));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify({ width, overflow })).toBe(true);
    await expect.poll(() => page.locator(".receiver:visible .parcel-title").evaluate((el) => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await capture(page, "long-name-parcel");
  await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
  await expect(page.locator(".receiver:visible h1")).toBeFocused();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator(".receiver:visible .keepsake-note").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await capture(page, "long-name-result");
});
test("recipient pending progress belongs to the dialog and return confirmation has one stage", async ({ page }) => {
  await prepare(page);
  await page.getByRole("button", { name: "Create share link", exact: true }).first().click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await page.getByRole("link", { name: "Open as recipient", exact: true }).click();
  await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
  const book = page.locator('.receiver:visible .panels > li[data-kind="book"]');
    await openPieceOptions(book);
  await book.getByRole("button", { name: "Already know this", exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/agent", async (route) => { await held; await route.abort(); });
  await page.clock.install();
  await page.getByRole("button", { name: "Find another", exact: true }).click();
  await page.clock.fastForward(9000);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toHaveCount(1);
  await expect(dialog).toContainText("Still preparing your draft. You can stop at any time.");
  await expect(dialog.getByRole("button", { name: "Stop", exact: true })).toHaveCount(1);
  await capture(page, "recipient-pending-dialog");
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  release(); await page.clock.resume();
  await expect(dialog.getByRole("button", { name: "Keep this piece", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Keep this piece", exact: true }).click();
  await page.getByRole("button", { name: "Make one back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Now, one from you.", exact: true })).toBeVisible();
  await expect(page.locator(".compose-actions")).toHaveCount(0);
  await expect(page.locator(".composer-inputs")).toHaveCount(0);
  await capture(page, "return-decision");
  await page.getByRole("button", { name: "Start with an empty shelf", exact: true }).click();
  await expect(page.getByText("0 favourites · 6 needed, 12 maximum", { exact: true })).toBeVisible();
  await expect(page.getByText("3 of 5 tastes", { exact: true })).toBeVisible();
  await capture(page, "return-without-import");
});
