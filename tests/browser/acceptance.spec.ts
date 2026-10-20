import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixture";
import type { Page } from "@playwright/test";
async function capture(page: Page, name: string, focus?: string) {
  if (!process.env.MIXTAPE_SHOTS_DIR) return;
  await mkdir(process.env.MIXTAPE_SHOTS_DIR, { recursive: true });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (!focus) await page.evaluate(() => scrollTo(0, 0));
    if (focus)
      await page
        .locator(focus)
        .first()
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: join(
        process.env.MIXTAPE_SHOTS_DIR,
        `${name}-${viewport.width}x${viewport.height}.png`,
      ),
      animations: "disabled",
    });
  }
}

test("own confirmed shelf, keyboard identity selection and two-piece format", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Make a mixtape", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Make their mixtape", exact: true }),
  ).toBeDisabled();
  await capture(page, "composer-empty");
  const shelf = page.locator(".shelf-section"),
    tastes = page.locator(".tastes-section");
  for (const [section, entries] of [
    [
      shelf,
      [
        ["Films", "Before Sunrise"],
        ["Films", "Paris, Texas"],
        ["Books", "Invisible Cities"],
        ["Books", "Kitchen"],
        ["Artists", "Nujabes"],
        ["Artists", "Khruangbin"],
      ],
    ],
    [
      tastes,
      [
        ["Films", "Spirited Away"],
        ["Books", "The Little Prince"],
        ["Artists", "Bon Iver"],
      ],
    ],
  ] as const) {
    for (const [kind, query] of entries) {
      await section.getByRole("button", { name: kind, exact: true }).click();
      const input = section.getByRole("combobox");
      await input.fill(query);
      await expect(
        section.getByRole("option").filter({ hasText: "Use this" }),
      ).toBeVisible();
      await input.press("ArrowDown");
      await input.press("Enter");
      await expect(input).toHaveValue("");
    }
  }
  await expect(
    page.getByText("6 favourites · 6 needed, 12 maximum", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("3 of 5 tastes", { exact: true })).toBeVisible();
  await page.locator(".format-details > summary").click();
  await page
    .getByRole("checkbox", { name: "An artist", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Make their mixtape", exact: true })
    .click();
  await expect(page.locator(".panels > li")).toHaveCount(2);
  await capture(page, "two-piece-result");
  await page.getByRole("button", { name: "Preview opening", exact: true }).click();
  await expect(page.locator(".receiver:visible .peek-insert")).toContainText("TWO THINGS.");
  await expect(page.locator(".receiver:visible .parcel-bottom")).not.toContainText("AN ARTIST");
  await capture(page, "two-piece-preview");
  await page.getByRole("button", { name: "Back to editing", exact: true }).click();
  await page.getByRole("button", { name: "Add 2 notes", exact: true }).first().click();
  await expect(page.getByRole("dialog").locator("textarea")).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await capture(page, "notes-required");
});

test("save failure preserves human text, offline view, search failure and responsive zoom", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Try this exchange", exact: true }).first()
    .click();
  await expect(page).toHaveURL(/\/make\//);
  const url = page.url();
  await page.route("**/api/drafts/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.fulfill({
        status: 503,
        json: { error: "Your latest edits are not saved yet." },
      });
    else await route.continue();
  });
  await page.locator(".personal-details > summary").click();
  await page
    .getByRole("textbox", { name: "A line from you", exact: true })
    .fill("<script>my words stay mine</script>");
  await page
    .getByRole("textbox", { name: "A line from you", exact: true })
    .blur();
  await expect(
    page.getByRole("status").filter({ hasText: "Your latest edits" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "A line from you", exact: true }),
  ).toHaveValue("<script>my words stay mine</script>");
  await page.locator("main").getByRole("alert").scrollIntoViewIfNeeded();
  await capture(page, "save-failed");
  await context.setOffline(true);
  await expect(
    page.getByText(
      "You are offline. You can read this view, but new choices and saves need a connection.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Make their mixtape", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => scrollTo(0, 0));
  await capture(page, "offline");
  await context.setOffline(false);
  await page.unroute("**/api/drafts/*");
  await page
    .getByRole("button", { name: "Try saving again", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved" }),
  ).toBeVisible();
  await page.reload();
  await page.locator(".personal-details > summary").click();
  await expect(
    page.getByRole("textbox", { name: "A line from you", exact: true }),
  ).toHaveValue("<script>my words stay mine</script>");
  await page.route("**/api/entities/search", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Search is unavailable right now." },
    }),
  );
  await page.getByRole("button", { name: "Edit favourites", exact: true }).click();
  await page.getByRole("combobox").first().fill("Before");
  await expect(
    page.getByText("Search is unavailable right now.", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("Search is unavailable right now.", { exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, "search-failed", ".entity-search");
  await page.unroute("**/api/entities/search");
  await page.getByRole("combobox").first().fill("zxnoresult");
  await expect(
    page.getByText(
      "This sample does not include that taste. Try live mode when it is available.",
      { exact: true },
    ),
  ).toBeVisible();
  await capture(page, "search-empty", ".entity-search");
  await page.getByRole("combobox").first().fill("the");
  await expect(page.getByText("Which film did you mean?", { exact: true })).toBeVisible();
  await capture(page, "search-ambiguous", ".entity-search");
  await page.getByRole("combobox").first().press("Escape");
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 720, height: 450 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
  });
  expect(page.url()).toBe(url);
});

test("bounded pending state can stop without changing the saved draft", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Try this exchange", exact: true }).first()
    .click();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/agent", async (route) => {
    await barrier;
    await route.abort().catch(() => {});
  });
  await page
    .getByRole("button", { name: "Make their mixtape", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Choosing from your shelf",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Choosing from your shelf", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, "preparing");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  release();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "Stopped. Your draft is still here.",
  );
  await expect(
    page.getByText("9 favourites · 6 needed, 12 maximum", { exact: true }),
  ).toBeVisible();
  await capture(page, "stopped");
});

test("actionable generation failures retain the last version and respect server reset", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Try this exchange", exact: true }).first()
    .click();
  await page
    .getByRole("button", { name: "Make their mixtape", exact: true })
    .click();
  await expect(page.locator(".panels > li")).toHaveCount(3);
  const titles = await page.locator(".panels h2").allTextContents();
  const d = await (
    await page.request.get(`/api/drafts/${page.url().split("/").at(-1)}`)
  ).json();
  await page.locator(".edition-menu > summary").click();
  await page.getByRole("button", { name: "Edit tastes", exact: true }).click();
  for (const [index, error] of [
    "Qloo did not return a choice from these favourites.",
    "We could not read Qloo's response. No new choices were saved.",
    "This is taking longer than it should. Your draft is safe.",
    "Qloo is unavailable right now. Your current mixtape is still here.",
    "We cannot reach Qloo with this setup.",
    "The agent could not finish this mixtape. Your last version is unchanged.",
    "New choices are unavailable right now. You can still open saved mixtapes.",
    "New mixtapes are paused for now. Saved links still work.",
    "We cannot start a new mixtape right now. Your saved version is still available.",
    "Mixtape is busy right now. Your draft is saved.",
    "This draft changed in another tab.",
  ].entries()) {
    await page.route("**/api/agent", (route) =>
      route.fulfill({ status: 503, json: { error } }),
    );
    await page
      .getByRole("button", { name: "Update their mixtape", exact: true })
      .click();
    await expect(page.locator("main").getByRole("alert")).toContainText(error);
    expect(await page.locator(".panels h2").allTextContents()).toEqual(titles);
    if (index === 0 || index === 4 || index === 10) {
      await page.locator("main").getByRole("alert").scrollIntoViewIfNeeded();
      await capture(page, `generation-failed-${index}`);
    }
    if (index === 0)
      await expect(
        page
          .locator("main")
          .getByRole("alert")
          .getByRole("button", { name: "Try again", exact: true }),
      ).toHaveCount(0);
    await page.unroute("**/api/agent");
  }
  await page.route("**/api/agent", (route) =>
    route.fulfill({
      status: 200,
      json: {
        run: {
          id: "test-partial",
          mode: "fixture",
          status: "needs_input",
          events: [
            {
              seq: 1,
              type: "needs_input",
              label: "Qloo did not return a choice from these favourites.",
              at: new Date().toISOString(),
              category: "artist",
            },
          ],
          partialSlots: d.revisions.at(-1).slots.slice(0, 2),
          attempts: 0,
          model: "deterministic-local-stub",
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Update their mixtape", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "We have 2 pieces. This artist needs another option.",
    }),
  ).toBeVisible();
  await page.locator(".partial-preview").scrollIntoViewIfNeeded();
  await capture(page, "partial", ".partial-preview h2");
  await page.unroute("**/api/agent");
  await page.route("**/api/agent", (route) =>
    route.fulfill({
      status: 429,
      json: {
        error: "Qloo needs a short pause. Try again later.",
        resetAt: Date.now() + 1500,
      },
    }),
  );
  await page
    .getByRole("button", { name: "Update their mixtape", exact: true })
    .click();
  const retry = page
    .locator("main")
    .getByRole("alert")
    .getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeDisabled();
  await expect(retry).toBeEnabled({ timeout: 4000 });
});

test("each sample starter resolves its own shelf and long titles remain readable", async ({
  page,
}) => {
  for (const [index, sender, recipient] of [
    [0, "Maya", "Leo"],
    [1, "Sam", "Jo"],
    [2, "Noor", "Alex"],
  ] as const) {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Try this exchange", exact: true })
      .nth(index)
      .click();
    await expect(
      page.getByRole("heading", {
        name: `A mixtape for ${recipient}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("9 favourites · 6 needed, 12 maximum", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Make their mixtape", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: `From ${sender}, for ${recipient}`,
        exact: true,
      }),
    ).toBeVisible();
    const d = await (
      await page.request.get(`/api/drafts/${page.url().split("/").at(-1)}`)
    ).json();
    const shelfIds = d.shelf.map(
      (e: { entity: { id: string } }) => e.entity.id,
    );
    expect(
      d.revisions
        .at(-1)
        .slots.every((s: { entity: { id: string } }) =>
          shelfIds.includes(s.entity.id),
        ),
    ).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    if (index > 0) await capture(page, `sample-${index + 1}`);
  }
});

test("share persistence failure, reload management, rotation, revocation and draft deletion", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Try this exchange", exact: true }).first()
    .click();
  await expect(page).toHaveURL(/\/make\//);
  const owner = page.url();
  await page
    .getByRole("button", { name: "Make their mixtape", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create share link", exact: true }).first()
    .click();
  await page.route("**/api/drafts/*/shares", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "The link was not created. Your draft is still here." },
    }),
  );
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "The link was not created. Your draft is still here.",
  );
  await expect(page.getByLabel("Their link", { exact: true })).toHaveCount(0);
  await capture(page, "share-failed");
  await page.unroute("**/api/drafts/*/shares");
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  const original = await page
    .getByLabel("Their link", { exact: true })
    .inputValue();
  await page.goto(owner);
  await page
    .getByRole("button", { name: "Create share link", exact: true }).first()
    .click();
  await page.getByText("Previously shared links", { exact: true }).click();
  await page
    .getByRole("button", { name: "Manage this link", exact: true })
    .click();
  await expect(page.getByLabel("Their link", { exact: true })).toHaveValue(
    original,
  );
  await page.getByText("Manage this link", { exact: true }).click();
  await page.getByRole("button", { name: "Replace link", exact: true }).click();
  await expect(page.getByLabel("Their link", { exact: true })).not.toHaveValue(
    original,
  );
  const rotated = await page
    .getByLabel("Their link", { exact: true })
    .inputValue();
  const reader = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "203.0.113.44" },
  });
  const other = await reader.newPage();
  await other.goto(original);
  await expect(
    other.getByRole("heading", {
      name: "This mixtape is no longer available.",
    }),
  ).toBeVisible();
  await other.goto(rotated);
  await expect(
    other.getByRole("heading", { name: "Maya made you a mixtape." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke link", exact: true }).click();
  await capture(page, "revoke-confirm");
  await page
    .getByRole("dialog", { name: "Stop this link from opening?" })
    .getByRole("button", { name: "Revoke link", exact: true })
    .click();
  await other.reload();
  await expect(
    other.getByRole("heading", {
      name: "This mixtape is no longer available.",
    }),
  ).toBeVisible();
  await page.goto("/drafts");
  await page.getByRole("button", { name: "Delete draft", exact: true }).click();
  await capture(page, "delete-confirm");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Keep draft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("link", { name: /Continue draft/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete draft", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No drafts yet." }),
  ).toBeVisible();
  await reader.close();
});
