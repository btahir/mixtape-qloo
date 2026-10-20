import { test, expect } from "./fixture";

test("cold sample opens a private gift and note writing preserves keyboard position", async ({ page }, info) => {
  expect(page.viewportSize()).toEqual(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const published: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/shares")) published.push(request.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sample gift", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Maya made you a mixtape." })).toBeVisible();
  await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
  expect(published).toEqual([]);
  await page.getByRole("button", { name: "Make this yours / share" }).click();
  const first = page.locator(".panels > li").first();
  await first.locator(".piece-menu > summary").click();
  const opener = first.locator(".note-editor-trigger");
  await opener.click();
  await expect(page.getByRole("dialog").locator("textarea")).toBeFocused();
  await page.getByRole("button", { name: "Save & next note" }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Your note for Invisible Cities");
  await expect(page.getByRole("dialog").locator("textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await opener.click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(opener).toBeFocused();
});

test("How it chooses navigation releases its dialog", async ({ page }) => {
  await page.route("**/api/comparisons", (route) => route.fulfill({ json: { href: "/compare/quiet-evenings" } }));
  await page.goto("/");
  await page.getByRole("button", { name: "How it chooses" }).click();
  await page.getByRole("link", { name: "See a comparison" }).click();
  await expect(page).toHaveURL(/\/compare\/quiet-evenings$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the sample is a working private receipt: repair, save and make one back without publishing", async ({ page }) => {
  const published: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/shares")) published.push(request.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: "Open a sample gift", exact: true }).click();
  await page.getByRole("button", { name: "Open your mixtape", exact: true }).click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
  for (const menu of await page.locator(".piece-menu").all()) {
    await menu.locator("summary").click();
    await expect(menu.locator(".panel-actions > *").first()).toBeVisible();
    await menu.locator("summary").click();
  }
  const book = page.locator(".panels > li").nth(1);
  const before = await book.locator("article").getAttribute("aria-label");
  await book.getByRole("button", { name: /Read it already\?/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Find another", exact: true }).click();
  await expect(page.getByText(/^Another book, from the same shelf\./)).toBeVisible();
  await expect(book.locator("article")).not.toHaveAttribute("aria-label", before!);
  await expect(book.getByRole("button", { name: /Read it already\?/ })).toHaveCount(0);
  const film = page.locator(".panels > li").first();
  await film.locator(".piece-menu > summary").click();
  await film.getByRole("button", { name: "Save this", exact: true }).click();
  await expect(film.getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator(".sample-next").getByRole("button", { name: "Make one back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Now, one from you.", exact: true })).toBeVisible();
  expect(published).toEqual([]);
});
