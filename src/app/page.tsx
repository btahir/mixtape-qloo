import { liveSample } from "@/lib/server/sample-manifest";
import { withRequestDeadline } from "@/lib/server/store";
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
async function SampleAvailability() {
  await connection();
  if (!process.env.QLOO_API_KEY || process.env.QLOO_MODE === "fixture") return null;
  try {
    if (await withRequestDeadline(3000, () => liveSample("quiet-evenings", "availability"))) return null;
  } catch { /* A missing warm-up must not turn the landing page into a 5xx. */ }
  return <p role="status">Live samples are currently unavailable. You can still start with your own favourites.</p>;
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
          <Suspense fallback={null}><SampleAvailability /></Suspense>
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
