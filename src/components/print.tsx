import type { Kind } from "@/lib/domain";
import { FittedTitle } from "./fitted-title";

export function Mark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 44 30"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="42" height="28" rx="4" />
      <circle cx="15" cy="15" r="7" />
      <circle cx="29" cy="15" r="7" />
      <path d="M15 8h14M15 22h14" />
    </svg>
  );
}
export function Parcel({
  sender = "Your",
  recipient = "A friend",
  categories = ["movie", "book", "artist"],
}: {
  sender?: string;
  recipient?: string;
  categories?: Kind[];
}) {
  return (
    <div className="object-stage" aria-hidden="true">
      <div className="stage-coordinate">
        PERSONAL EDITION <span>01</span>
      </div>
      <div className="peek-insert">
        {categories.length === 2 ? "TWO THINGS." : "THREE THINGS."}
        <br />
        ONE PERSON.
      </div>
      <div className="parcel">
        <div className="parcel-topline">
          MIXTAPE EXCHANGE <span>VOL. 01</span>
        </div>
        <FittedTitle className="parcel-title" title={sender}>
          <span>{sender === "Your" ? "YOUR" : `${sender}’S`}</span>
          <span>WORLD.</span>
          <span><em>THEIR</em></span>
          <span>FREQUENCY.</span>
        </FittedTitle>
        <svg
          className="parcel-graphic"
          viewBox="0 0 240 240"
          fill="none"
          stroke="currentColor"
          strokeWidth="12"
        >
          <ellipse cx="120" cy="120" rx="102" ry="85" />
          <ellipse cx="120" cy="120" rx="77" ry="61" />
          <ellipse cx="120" cy="120" rx="51" ry="37" />
          <circle cx="120" cy="120" r="13" />
        </svg>
        <div className="address-label">
          <small>MADE FOR</small>
          <strong>{recipient}</strong>
          <span>↗</span>
        </div>
        <div className="parcel-bottom">
          SELECTED WITH CARE <span>{categories.map((kind) => kind === "movie" ? "A FILM" : kind === "book" ? "A BOOK" : "AN ARTIST").join(". ")}.</span>
        </div>
        <div className="tear-strip">
          A LITTLE SOMETHING FOR YOU <span>↓</span>
        </div>
      </div>
      <div className="object-caption">
        A few favourites. A whole little world.
      </div>
    </div>
  );
}
export function PrintCover({
  kind,
  title,
  index,
}: {
  kind: Kind;
  title: string;
  index: number;
}) {
  return (
    <div className={`print-cover cover-${kind}`} aria-hidden="true">
      <div className="cover-meta">
        <span>
          0{index + 1} /{" "}
          {kind === "movie"
            ? "A FILM"
            : kind === "book"
              ? "A BOOK"
              : "AN ARTIST"}
        </span>
      </div>
      {kind === "movie" ? (
        <>
          <div className="sun-disc" />
          <div className="window-lines">
            <i />
            <i />
            <i />
            <i />
          </div>
        </>
      ) : kind === "artist" ? (
        <div className="record-rings">
          <i />
          <i />
          <i />
          <i />
          <span />
        </div>
      ) : (
        <svg
          className="book-lines"
          viewBox="0 0 340 240"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M-10 160C40 130 70 190 110 152s52-30 80-12 50-15 70-5 70 5 100-15M-10 185c50-30 80 30 120-8s52-30 80-12 50-15 70-5 70 5 100-15M-10 210c50-30 80 30 120-8s52-30 80-12 50-15 70-5 70 5 100-15" />
          <path d="m199 172 14-86 13 86m-13-86 1-35M188 116l27-32 30 33m-49 14 20-22 23 23" />
        </svg>
      )}
      <FittedTitle title={title} />
    </div>
  );
}
