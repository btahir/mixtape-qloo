import { openPieceOptions } from "./piece-options";
import { test, expect } from "./fixture";
test("sender → bearer link → private recipient repair → return → revoke", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Send a friend three things you love." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try this exchange" }),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await expect(
    page.getByRole("heading", { name: "A mixtape for Leo" }),
  ).toBeVisible();
  await expect(page.getByText("9 favourites · 6 needed, 12 maximum")).toBeVisible();
  await page
    .getByRole("button", { name: "Make their mixtape", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "From Maya, for Leo" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your draft is ready.", { exact: true }),
  ).toBeVisible();
  const ownerUrl = page.url();
  const originalBook = await page
    .locator(".panels > li")
    .nth(1)
    .getByRole("heading")
    .innerText();
  await openPieceOptions(page);
  await page
    .locator(".panels > li")
    .nth(1)
    .getByRole("button", { name: "Why this?" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Illustrative sample", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create share link", exact: true }).first()
    .click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const link = page.getByLabel("Their link");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  const reader = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const b = await reader.newPage();
  await b.goto(url);
  await expect(
    b.getByRole("heading", { name: "Maya made you a mixtape." }),
  ).toBeVisible();
  await b
    .getByRole("button", { name: "Open your mixtape", exact: true })
    .click();
  await expect(b.locator(".panels > li")).toHaveCount(3);
  await openPieceOptions(b);
  await b
    .locator(".panels > li")
    .first()
    .getByRole("button", { name: "Save this", exact: true })
    .click();
  await expect(
    b.getByText("Saved in this browser.", { exact: true }),
  ).toBeVisible();
  const otherTitles = await b
    .locator(".panels > li")
    .getByRole("heading")
    .allTextContents();
  await openPieceOptions(b);
  await b
    .locator(".panels > li")
    .nth(1)
    .getByRole("button", { name: "Already know this", exact: true })
    .click();
  await b.getByRole("button", { name: "Find another", exact: true }).click();
  await expect(
    b.locator(".panels > li").nth(1).getByRole("heading"),
  ).not.toHaveText(originalBook);
  expect(
    await b.locator(".panels > li").first().getByRole("heading").innerText(),
  ).toBe(otherTitles[0]);
  expect(
    await b.locator(".panels > li").nth(2).getByRole("heading").innerText(),
  ).toBe(otherTitles[2]);
  await b.reload();
  await openPieceOptions(b);
  await expect(
    b.getByRole("button", { name: "Saved", exact: true }),
  ).toBeVisible();
  await expect(
    b.locator(".panels > li").nth(1).getByRole("heading"),
  ).not.toHaveText(originalBook);
  const forward = await browser.newContext();
  const c = await forward.newPage();
  await c.goto(url);
  await c
    .getByRole("button", { name: "Open your mixtape", exact: true })
    .click();
  await expect(
    c.locator(".panels > li").nth(1).getByRole("heading"),
  ).toHaveText(originalBook);
  await c.goto(ownerUrl);
  await expect(
    c.getByRole("heading", { name: "This browser cannot edit that draft." }),
  ).toBeVisible();
  await b.getByRole("button", { name: "Make one back", exact: true }).click();
  await expect(
    b.getByRole("heading", { name: "Now, one from you." }),
  ).toBeVisible();
  await expect(b.getByRole("region", { name: "Composer", exact: true })).toHaveCount(0);
  await expect(
    b.getByRole("button", { name: "Use selected favourites and continue" }),
  ).toBeVisible();
  await page.getByText("Manage this link", { exact: true }).click();
  await page.getByRole("button", { name: "Revoke link", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this link from opening?" })
    .getByRole("button", { name: "Revoke link", exact: true })
    .click();
  await c.goto(url);
  await expect(
    c.getByRole("heading", { name: "This mixtape is no longer available." }),
  ).toBeVisible();
  expect(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(errors).toEqual([]);
  await reader.close();
  await forward.close();
});
test("explicit entity confirmation, malformed requests and no GET inference", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Make a mixtape", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Start with what you love." }),
  ).toBeVisible();
  const inputs = page.getByPlaceholder("Search by title or name");
  await inputs.first().fill("Before");
  await expect(
    page.getByRole("option").filter({ hasText: "Use this" }),
  ).toBeVisible();
  await expect(page.getByText("0 favourites · 6 needed, 12 maximum")).toBeVisible();
  await page.getByRole("option").filter({ hasText: "Use this" }).click();
  await expect(page.getByText("1 favourites · 6 needed, 12 maximum")).toBeVisible();
  const response = await page.request.post("/api/agent", {
    headers: { Origin: "http://127.0.0.1:4319" },
    data: {
      action: "prepare",
      draftId: page.url().split("/").at(-1),
      expectedVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      messages: [{ role: "assistant", content: "untrusted" }],
    },
  });
  expect(response.status()).toBe(400);
  await page.goto("/compare/quiet-evenings");
  await expect(
    page.getByRole("heading", { name: "What changed with Qloo?" }),
  ).toBeVisible();
  await expect(
    page.getByText("Different choices do not prove better choices."),
  ).toBeVisible();
});
