import { Parcel } from "@/components/print";
import { connection } from "next/server";
import { headers } from "next/headers";
import { rate } from "@/lib/server/limits";
import { ipKey } from "@/lib/server/security";
import { Suspense } from "react";
import { Start, Samples, DraftList } from "@/components/landing";
import { listDrafts } from "@/lib/server/repository";
import { session } from "@/lib/server/security";
import { AppError } from "@/lib/server/errors";
async function Recent() {
  await connection();
  let drafts;
  try {
    const owner = await session();
    await rate("read", owner, ipKey(new Request("http://localhost", { headers: await headers() })));
    drafts = await listDrafts(owner, 3);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) return null;
    return <p role="alert">Your saved drafts could not be loaded. <a href="/drafts">Try again</a></p>;
  }
  return drafts.length ? (
    <section>
      <h2>Pick up where you left off</h2>
      <DraftList initial={drafts.slice(0, 3)} />
      <Start label="Start another" />
    </section>
  ) : null;
}
export default function Home() {
  return (
    <>
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="eyebrow">A cultural care package</p>
          <h1>
            Send a friend three things <em>you love.</em>
          </h1>
          <p>
            Add your favourites and a few of theirs. Mixtape chooses a film, a
            book and an artist from your shelf.
          </p>
          <div className="hero-actions">
            <Start sampleId="quiet-evenings" openGift label="Open a sample gift" />
            <Start />
          </div>
          <p className="fine-print">
            A fictional exchange, chosen with Qloo. No account needed.
          </p>
        </div>
        <div className="hero-gift"><Parcel sender="Maya" recipient="Leo" /><p className="gift-caption"><span>Maya → Leo</span> A film. A book. An artist.<br /><em>And the reasons she loves them.</em></p></div>
      </section>
      <Samples />
      <Suspense fallback={null}>
        <Recent />
      </Suspense>
    </>
  );
}
