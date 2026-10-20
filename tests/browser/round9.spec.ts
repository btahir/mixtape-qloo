import { test, expect } from "./fixture";

test("clicks on a painted starter before hydration are kept, and create exactly one draft", async ({ page }) => {
  let release!: () => void;
  const scripts = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/_next/static/**/*.js", async (route) => { await scripts; await route.continue(); });
  let requests = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/drafts") && request.method() === "POST") requests++; });
  await page.goto("/", { waitUntil: "commit" });
  const start = page.getByRole("button", { name: "Try this exchange", exact: true }).first();
  await expect(start).toBeEnabled();
  await start.click();
  await start.click();
  expect(await start.evaluate((button) => button.hasAttribute("data-live"))).toBe(false);
  expect(requests).toBe(0);
  release();
  await expect(page).toHaveURL(/\/make\//);
  expect(requests).toBe(1);
});

test("mobile search brings matches above the generation bar without keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await page.getByRole("button", { name: "Edit favourites", exact: true }).click();
  const input = page.locator("#favourites").getByRole("combobox");
  await input.fill("the");
  await expect(page.getByRole("option").first()).toBeVisible();
  await expect.poll(async () => page.getByRole("option").first().evaluate((row) => row.getBoundingClientRect().bottom < document.querySelector(".compose-actions")!.getBoundingClientRect().top)).toBe(true);
  await expect(input).toBeFocused();
});

test("narrow receiving keeps Open on screen and the footer reflows at 200 percent", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try this exchange", exact: true }).first().click();
  await page.getByRole("button", { name: "Make their mixtape", exact: true }).click();
  await page.getByRole("button", { name: "Create share link", exact: true }).first().click();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const link = await page.getByLabel("Their link", { exact: true }).inputValue();
  await page.goto(link);
  const open = page.getByRole("button", { name: "Open your mixtape", exact: true });
  const box = await open.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(800);
  await open.click();
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
  await page.goto("/compare/quiet-evenings");
  await expect(page.locator(".comparison-nav")).toBeVisible();
  for (const link of await page.locator(".comparison-nav a").all()) {
    expect(await link.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    const box = await link.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});
