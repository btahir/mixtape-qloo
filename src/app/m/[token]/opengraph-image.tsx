import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { rate } from "@/lib/server/limits";
import { ipKey } from "@/lib/server/security";
import { connection } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publicShare } from "@/lib/server/repository";

export const alt = "A Mixtape: a film, a book and an artist, chosen for a friend.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return new Response(null, { status: 404 });
  try { await rate("read", "", ipKey(new Request("http://local", { headers: await headers() }))); }
  catch { return new Response(null, { status: 429 }); }
  const share = await publicShare(token).catch(() => null);
  if (!share) return new Response(null, { status: 404 });
  const font = await readFile(join(process.cwd(), "public/fonts/bricolage-og.ttf"));
  const slots = share?.revision.slots ?? [];
  return new ImageResponse(
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", padding: "42px 52px", background: "#f4f1e7", color: "#223a34", fontFamily: "Bricolage" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24 }}><span>Mixtape.</span><span style={{ background: "#e7d795", padding: "8px 16px", fontSize: 17 }}>PERSONAL EDITION · MADE FOR {(share.recipient || "YOU").toUpperCase()}</span></div>
      <div style={{ display: "flex", fontSize: 58, letterSpacing: -2, margin: "26px 0 28px" }}>{share ? `From ${share.sender || "a friend"}, for ${share.recipient || "you"}.` : "A few favourites. Just for you."}</div>
      <div style={{ display: "flex", gap: 16, flex: 1 }}>
        {slots.map((slot, index) => <div key={slot.kind} style={{ display: "flex", position: "relative", overflow: "hidden", flexDirection: "column", flex: 1, padding: "24px", background: ["#b83a22", "#e7d795", "#223a34"][index], color: index === 1 ? "#223a34" : "#fffdf5", transform: `rotate(${index === 1 ? 1 : -1}deg)` }}>
          <svg width="230" height="230" viewBox="0 0 240 240" style={{ position: "absolute", right: -40, top: -12, opacity: .22 }} fill="none" stroke={index === 1 ? "#223a34" : "#fffdf5"} strokeWidth="9">
            <ellipse cx="120" cy="120" rx="102" ry="85" /><ellipse cx="120" cy="120" rx="77" ry="61" /><ellipse cx="120" cy="120" rx="51" ry="37" /><circle cx="120" cy="120" r="13" />
          </svg>
          <div style={{ display: "flex", fontSize: 17, letterSpacing: 2 }}>{`0${index + 1} / ${slot.kind === "movie" ? "A FILM" : slot.kind === "book" ? "A BOOK" : "AN ARTIST"}`}</div>
          <div style={{ display: "flex", fontSize: slot.entity.name.length > 35 ? 31 : 42, lineHeight: 1.08, letterSpacing: -1, marginTop: "auto", paddingTop: 24 }}>{slot.entity.name}</div>
          <div style={{ display: "flex", marginTop: 24, borderTop: "1px solid currentColor", paddingTop: 12, fontSize: 15 }}>FROM {share.sender.toUpperCase() || "A FRIEND"}’S WORLD</div>
        </div>)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 28, fontSize: 20 }}><span>{slots.length ? `${slots.length} favourites. One person in mind.` : "Open a little of their world."}</span><span>OPEN YOUR MIXTAPE</span></div>
    </div>,
    { ...size, fonts: [{ name: "Bricolage", data: font, weight: 600, style: "normal" }], headers: { "Cache-Control": "private, no-store" } },
  );
}
