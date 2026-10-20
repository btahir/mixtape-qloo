import { openPieceOptions } from "./piece-options";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture";

async function shot(page: Page, name: string, fullPage = false) {
  await page.evaluate(() => document.fonts.ready);
  if (!(await page.getByRole("dialog").count()))
    await page.evaluate(() => scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (!process.env.MIXTAPE_SHOTS_DIR) return;
  await mkdir(process.env.MIXTAPE_SHOTS_DIR, { recursive: true });
  const size = page.viewportSize()!;
  await page.screenshot({
    path: join(
      process.env.MIXTAPE_SHOTS_DIR,
      `${name}-${size.width}x${size.height}${fullPage ? "-full" : ""}.png`,
    ),
    fullPage,
    animations: "disabled",
  });
}
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`designed complete exchange at ${viewport.width}`, async ({
    browser,
  }) => {
    test.setTimeout(60000);
    const context = await browser.newContext({
      viewport,
      extraHTTPHeaders: {
        "x-forwarded-for": viewport.width === 1440 ? "192.0.2.14" : "192.0.2.3",
      },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await shot(page, "landing");
    await shot(page, "landing", true);
    await page
      .getByRole("button", { name: "How it chooses", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Your words stay yours.",
    );
    await shot(page, "how");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "How it chooses", exact: true }),
    ).toBeFocused();
    await page.getByRole("link", { name: "My drafts", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No drafts yet." }),
    ).toBeVisible();
    await shot(page, "drafts-empty");
    await page.goto("/");
    const start = Date.now();
    await page
      .getByRole("button", { name: "Try this exchange", exact: true }).first()
      .click();
    await expect(
      page.getByText("9 favourites · 6 needed, 12 maximum", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, "composer");
    await shot(page, "composer", true);
    await page.getByRole("button", { name: "Edit favourites", exact: true }).click();
    await page.locator(".shelf-inventory > summary").click();
    await page.locator(".shelf-list > li").first().locator("summary").click();
    await expect(
      page
        .getByRole("textbox", { name: "Why I love this: Before Sunrise", exact: true })
        .first(),
    ).toHaveValue(
      "I love how much can happen when two people just keep talking.",
    );
    await page
      .getByRole("button", { name: "Make their mixtape", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "From Maya, for Leo", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, "result");
    await shot(page, "result", true);
    const first = page.locator(".panels > li").first();
    const title = await first.getByRole("heading").innerText();
    await openPieceOptions(first);
  await first.getByRole("button", { name: "Why this?", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Their tastes");
    await expect(page.getByRole("dialog")).toContainText("Illustrative sample");
    await shot(page, "evidence");
    await page.keyboard.press("Escape");
    await expect(
      first.getByRole("button", { name: "Why this?", exact: true }),
    ).toBeFocused();
    await openPieceOptions(first);
  await first.getByRole("button", { name: "Keep this", exact: true }).click();
    await expect(first.getByText("Kept by you", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Preview opening", exact: true })
      .click();
    await expect(
      page.getByText("Preview · Only you can see this draft", { exact: true }),
    ).toBeVisible();
    await shot(page, "preview");
    await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
    await expect(page.locator(".receiver:visible .panels > li")).toHaveCount(3);
    await shot(page, "preview-open");
    await page
      .getByRole("button", { name: "Back to editing", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create share link", exact: true }).first()
      .click();
    await shot(page, "share-review");
    await page
      .getByRole("button", { name: "Create link", exact: true })
      .click();
    const link = page.getByLabel("Their link", { exact: true });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("test denied")) },
      });
    });
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toContainText(
      "Copy did not work.",
    );
    await shot(page, "share-created");
    const receiver = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
      extraHTTPHeaders: {
        "x-forwarded-for": viewport.width === 1440 ? "192.0.2.15" : "192.0.2.4",
      },
    });
    const recipient = await receiver.newPage();
    recipient.on("pageerror", (e) => errors.push(e.message));
    await recipient.goto(url);
    await expect(recipient.getByRole("heading", { name: "Maya made you a mixtape.", exact: true })).toBeVisible();
    await shot(recipient, "receive-closed");
    await recipient
      .getByRole("button", { name: "Open your mixtape", exact: true })
      .click();
    await expect(recipient.locator(".panels > li")).toHaveCount(3);
    await expect(recipient.getByText("Kept by Maya", { exact: true })).toBeVisible();
    await shot(recipient, "receive-open");
    await shot(recipient, "receive-open", true);
    const book = recipient.locator(".panels > li").nth(1);
    const originalBook = await book.getByRole("heading").innerText();
    await openPieceOptions(book);
    await book
      .getByRole("button", { name: "Already know this", exact: true })
      .click();
    await shot(recipient, "repair");
    await recipient
      .getByRole("button", { name: "Find another", exact: true })
      .click();
    await expect(book.getByRole("heading")).not.toHaveText(originalBook);
    await expect(
      recipient.locator(".panels > li").first().getByRole("heading"),
    ).toHaveText(title);
    await recipient.evaluate(() => scrollTo(0, 0));
    await shot(recipient, "replaced");
    await openPieceOptions(book);
  await book.getByRole("button", { name: "Why this?", exact: true }).click();
    await expect(recipient.getByRole("dialog")).toContainText("Their tastes");
    await recipient.keyboard.press("Escape");
    await openPieceOptions(book);
  await book
      .getByRole("button", { name: "Undo replacement", exact: true })
      .click();
    await expect(book.getByRole("heading")).toHaveText(originalBook);
    await shot(recipient, "undo");
    await recipient
      .getByRole("button", { name: "Your saved pieces", exact: true })
      .click();
    await expect(
      recipient.getByText("Nothing saved yet.", { exact: true }),
    ).toBeVisible();
    await shot(recipient, "saved-empty");
    await recipient
      .getByRole("button", { name: "Show all pieces", exact: true })
      .click();
    await openPieceOptions(recipient);
  await recipient
      .locator(".panels > li")
      .first()
      .getByRole("button", { name: "Save this", exact: true })
      .click();
    await recipient
      .getByRole("button", { name: "Your saved pieces", exact: true })
      .click();
    await expect(recipient.locator(".saved-collection li")).toHaveCount(1);
    await shot(recipient, "saved");
    await recipient
      .getByRole("button", { name: "Make one back", exact: true })
      .click();
    await expect(
      recipient.getByRole("heading", {
        name: "Now, one from you.",
        exact: true,
      }),
    ).toBeVisible();
    await recipient.evaluate(() => scrollTo(0, 0));
    await shot(recipient, "return");
    const elapsed = Date.now() - start;
    console.log(
      `Fixture judge journey with screenshots (${viewport.width}): ${elapsed}ms`,
    );
    expect(elapsed).toBeLessThan(60000);
    await recipient
      .getByRole("button", { name: "Use selected favourites and continue", exact: true })
      .click();
    await expect(
      recipient.getByText("3 favourites · 6 needed, 12 maximum", { exact: true }),
    ).toBeVisible();
    await recipient.goto("/compare/quiet-evenings");
    await expect(
      recipient.getByRole("heading", {
        name: "What changed with Qloo?",
        exact: true,
      }),
    ).toBeVisible();
    await shot(recipient, "comparison");
    await shot(recipient, "comparison", true);
    await recipient.goto("/m/unavailable");
    await expect(
      recipient.getByRole("heading", {
        name: "This mixtape is no longer available.",
      }),
    ).toBeVisible();
    await shot(recipient, "unavailable");
    await page.keyboard.press("Escape");
    await page.goto("/drafts");
    await expect(
      page.getByRole("link", { name: /Continue draft/ }),
    ).toBeVisible();
    await shot(page, "drafts");
    expect(errors).toEqual([]);
    await receiver.close();
    await context.close();
  });
}
