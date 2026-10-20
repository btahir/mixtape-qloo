import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { headers } from "next/headers";
import { publicShare, existingGift } from "@/lib/server/repository";
import { session, ipKey } from "@/lib/server/security";
import { rate } from "@/lib/server/limits";
import { Receiver } from "@/components/receiver";
import { AppError } from "@/lib/server/errors";
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  await connection();
  const share = await publicShare((await params).token).catch(() => null);
  const title = share ? `${share.sender || "A friend"} made ${share.recipient || "you"} a mixtape` : "Mixtape";
  const description = share ? share.revision.slots.map((s) => s.entity.name).join(" · ") + ". A few favourites, chosen for you." : "A little of a friend’s world.";
  return { title, description, openGraph: { title, description, type: "website" }, twitter: { card: "summary_large_image", title, description } };
}
async function Content({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  let gift;
  let ownerDraftId: string | undefined;
  let temporary: AppError | null = null;
  try {
    const h = await headers();
    try { await rate("read", "", ipKey(new Request("http://local", { headers: h }))); }
    catch (error) { if (!(error instanceof AppError) || error.status !== 503) throw error; }
    // A closed write-admission gate must not hide an existing immutable gift.
    const s = await publicShare(token);
    let owner: string | undefined;
    try { owner = await session(); }
    catch (e) { if (!(e instanceof AppError) || e.status !== 403) throw e; }
    gift = await existingGift(s, owner);
    if (owner && s.owner === owner) ownerDraftId = s.draftId;
  } catch (e) {
    if (!(e instanceof AppError) || e.status !== 404)
      temporary = e instanceof AppError ? e : new AppError(503, "We cannot open this mixtape right now.");
  }
  return gift ? (
    <Receiver initial={gift} token={token} ownerDraftId={ownerDraftId} />
  ) : temporary ? (
    <><h1>We cannot open this mixtape right now.</h1>
      <p>{temporary.status === 429 ? "A few mixtapes were opened quickly. Please try again shortly." : "Please try again. The link may still be available."}</p>
      <a href={`/m/${encodeURIComponent(token)}`}>Try again</a>
    </>
  ) : (
    <>
      <h1>This mixtape is no longer available.</h1>
      <p>Ask the sender for a new link, or make one of your own.</p>
      <Link href="/">Make a mixtape</Link>
    </>
  );
}
export default function Receive(props: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<p>Opening your mixtape…</p>}>
      <Content {...props} />
    </Suspense>
  );
}
