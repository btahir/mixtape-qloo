import { test as base, chromium } from "@playwright/test";
// Always use the bundled headless shell, without channel or executable overrides.
export const test = base.extend({
  context: async ({ browser, contextOptions, viewport, isMobile, hasTouch }, provide, testInfo) => {
    const octet =
      ([...testInfo.testId].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
        250) +
      1;
    const context = await browser.newContext({
      ...contextOptions,
      viewport: viewport ?? { width: 1440, height: 900 },
      isMobile, hasTouch,
      extraHTTPHeaders: { origin: testInfo.project.use.baseURL ?? "http://127.0.0.1:4319", "x-forwarded-for": `198.51.100.${octet}` },
    });
    await provide(context);
    await context.close();
  },
  browser: [
    async ({}, provide) => {
      const browser = await chromium.launch();
      await provide(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],
});
export { expect } from "@playwright/test";
