import { ImageResponse } from "next/og";
import { Poster, posterAlt, posterFonts } from "@/lib/og/poster";

export const alt = posterAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default async function Image() {
  return new ImageResponse(<Poster {...size} />, {
    ...size,
    fonts: await posterFonts(),
    headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" },
  });
}
