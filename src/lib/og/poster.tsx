import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Shared art for the homepage card and the repository's social preview. */
export const posterAlt =
  "Mixtape: Maya sends Leo a film, a book and an artist from her own favourites.";
const paper = "#f4f1e7", ink = "#223a34", accent = "#b83a22", yellow = "#e7d795", rings = "#e66135", muted = "#5e6c64";

export async function posterFonts() {
  const font = (file: string) => readFile(join(process.cwd(), "public/fonts", file));
  const [display, serif, body] = await Promise.all([
    font("bricolage-og.ttf"),
    font("instrument-serif-italic-og.ttf"),
    font("dm-sans-og.ttf"),
  ]);
  return [
    { name: "Bricolage", data: display, weight: 600 as const, style: "normal" as const },
    { name: "Serif", data: serif, weight: 400 as const, style: "italic" as const },
    { name: "Body", data: body, weight: 400 as const, style: "normal" as const },
  ];
}

function Mark({ size, color = ink, stroke = 2.2 }: { size: number; color?: string; stroke?: number }) {
  return (
    <svg width={size} height={(size * 30) / 44} viewBox="0 0 44 30" fill="none" stroke={color} strokeWidth={stroke}>
      <rect x="1" y="1" width="42" height="28" rx="4" />
      <circle cx="15" cy="15" r="7" />
      <circle cx="29" cy="15" r="7" />
      <path d="M15 8h14M15 22h14" />
    </svg>
  );
}

/** A record-mailer poster: the pitch on the left, Maya's parcel for Leo on the right. */
export function Poster({ width, height }: { width: number; height: number }) {
  const pad = Math.round(width * 0.053);
  const picks = [
    { label: "A FILM", name: "Amélie" },
    { label: "A BOOK", name: "Invisible Cities" },
    { label: "AN ARTIST", name: "Khruangbin" },
  ];
  return (
    <div style={{ display: "flex", width, height, background: paper, color: ink, fontFamily: "Body", position: "relative", overflow: "hidden" }}>
      {/* Left column: name, promise, and the real sample exchange. */}
      <div style={{ display: "flex", flexDirection: "column", width: width * 0.56, height, padding: `${pad}px 0 ${pad}px ${pad}px` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "Bricolage", fontSize: 34, letterSpacing: -1.5 }}>
          <Mark size={46} />
          <span style={{ display: "flex" }}>Mixtape<span style={{ color: accent }}>.</span></span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto" }}>
          <div style={{ display: "flex", fontFamily: "Bricolage", fontSize: 74, lineHeight: 0.98, letterSpacing: -4 }}>Send a friend</div>
          <div style={{ display: "flex", fontFamily: "Bricolage", fontSize: 74, lineHeight: 0.98, letterSpacing: -4 }}>three things</div>
          <div style={{ display: "flex", fontFamily: "Serif", fontStyle: "italic", fontSize: 96, lineHeight: 0.95, letterSpacing: -3, marginTop: 2 }}>you love.</div>
          <div style={{ display: "flex", fontSize: 25, lineHeight: 1.4, color: muted, marginTop: 26, maxWidth: width * 0.47 }}>
            A film, a book and an artist from your own favourites, matched to their tastes with Qloo.
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 34, paddingTop: 18, borderTop: `1.5px solid ${ink}`, fontSize: 16, letterSpacing: 2.4 }}>
          <span>MAYA → LEO · A SAMPLE EXCHANGE</span>
          <span style={{ color: accent }}>MIXTAPE.SHIPTIFFIN.APP</span>
        </div>
      </div>
      {/* Right column: the parcel, an insert peeking out, and its tear strip. */}
      <div style={{ display: "flex", position: "absolute", left: width * 0.58, top: height * 0.08, width: width * 0.44, height: height * 0.86 }}>
        <div style={{ display: "flex", flexDirection: "column", position: "absolute", top: 0, left: 64, width: 400, height: 240, background: yellow, border: "1.5px solid #c9bc84", transform: "rotate(7deg)", padding: "26px 28px", fontFamily: "Bricolage", fontSize: 30, lineHeight: 1, letterSpacing: -1.2 }}>
          <span>THREE THINGS.</span>
          <span>ONE PERSON.</span>
        </div>
        <div style={{ display: "flex", position: "absolute", top: 82, left: 8, width: 470, height: 318, background: ink, color: paper, border: "1.5px solid #142c25", borderBottom: "5px solid #142c25", transform: "rotate(-6deg)", boxShadow: "3px 5px 0 #536158" }}>
          <div style={{ display: "flex", position: "absolute", top: 20, left: 24, right: 52, justifyContent: "space-between", fontSize: 11, letterSpacing: 2.2 }}>
            <span>MIXTAPE EXCHANGE</span><span>VOL. 01</span>
          </div>
          <svg width="214" height="214" viewBox="0 0 240 240" fill="none" stroke={rings} strokeWidth="13" style={{ position: "absolute", right: 34, top: 38 }}>
            <ellipse cx="120" cy="120" rx="102" ry="85" /><ellipse cx="120" cy="120" rx="77" ry="61" /><ellipse cx="120" cy="120" rx="51" ry="37" /><circle cx="120" cy="120" r="13" />
          </svg>
          <div style={{ display: "flex", flexDirection: "column", position: "absolute", top: 54, left: 24, fontFamily: "Bricolage", fontSize: 44, lineHeight: 0.95, letterSpacing: -2 }}>
            <span>MAYA’S</span>
            <span>WORLD.</span>
            <span style={{ fontFamily: "Serif", fontStyle: "italic", fontSize: 50, letterSpacing: -1.5 }}>THEIR</span>
            <span>FREQUENCY.</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", position: "absolute", right: 44, bottom: 26, width: 146, padding: "10px 14px", background: paper, color: ink, transform: "rotate(5deg)" }}>
            <span style={{ fontSize: 10, letterSpacing: 1.5 }}>MADE FOR</span>
            <span style={{ fontFamily: "Serif", fontStyle: "italic", fontSize: 38, lineHeight: 1.05 }}>Leo</span>
          </div>
          <div style={{ display: "flex", position: "absolute", left: 24, bottom: 16, fontSize: 9, letterSpacing: 2 }}>SELECTED WITH CARE</div>
          <div style={{ display: "flex", position: "absolute", right: -16, top: 18, bottom: 18, width: 34, background: accent, borderLeft: "1.5px dashed rgba(255,248,240,.6)" }} />
        </div>
        <div style={{ display: "flex", position: "absolute", left: 36, bottom: 4, gap: 10 }}>
          {picks.map((pick, index) => (
            <div key={pick.label} style={{ display: "flex", flexDirection: "column", width: 138, padding: "12px 14px", background: [accent, yellow, ink][index], color: index === 1 ? ink : paper, transform: `rotate(${[-3, 1.5, -1][index]}deg)` }}>
              <span style={{ fontSize: 10, letterSpacing: 1.6 }}>{`0${index + 1} / ${pick.label}`}</span>
              <span style={{ fontFamily: "Bricolage", fontSize: 21, lineHeight: 1.05, letterSpacing: -0.6, marginTop: 14 }}>{pick.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The app icon: the cassette mark on ink, sized to sit inside a maskable safe zone. */
export function AppIcon({ size }: { size: number }) {
  return (
    <div style={{ display: "flex", width: size, height: size, alignItems: "center", justifyContent: "center", background: ink }}>
      <Mark size={size * 0.6} color={paper} stroke={2.6} />
    </div>
  );
}
