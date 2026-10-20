/**
 * Renders the static brand images from the same art as the homepage card:
 * docs/social-preview.png (GitHub, 1280×640), the manifest icons and the Apple touch icon.
 * Run with: bun scripts/social-preview.tsx
 */
import { ImageResponse } from "next/og";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReactElement } from "react";
import { AppIcon, Poster, posterFonts } from "../src/lib/og/poster";
const fonts = await posterFonts();
async function render(out: string, element: ReactElement, width: number, height: number) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await new ImageResponse(element, { width, height, fonts }).arrayBuffer()));
  console.log(`Wrote ${out} (${width}×${height})`);
}
await render("docs/social-preview.png", <Poster width={1280} height={640} />, 1280, 640);
for (const size of [192, 512]) await render(`public/icons/icon-${size}.png`, <AppIcon size={size} />, size, size);
await render("src/app/apple-icon.png", <AppIcon size={180} />, 180, 180);
