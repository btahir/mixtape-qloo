import type { Page, Locator } from "@playwright/test";
export async function openPieceOptions(scope: Page | Locator) {
  await scope.locator('.piece-menu:visible').first().waitFor({ state: 'attached' });
  const closed = scope.locator('.piece-menu:not([open]):visible > summary');
  while (await closed.count()) {
    const menu = closed.first();
    await menu.scrollIntoViewIfNeeded();
    await menu.click();
  }
}
