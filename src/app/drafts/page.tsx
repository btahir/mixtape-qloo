import { connection } from "next/server";
import { headers } from "next/headers";
import { rate } from "@/lib/server/limits";
import { ipKey } from "@/lib/server/security";
import { Suspense } from "react";
import { DraftList } from "@/components/landing";
import { listDrafts } from "@/lib/server/repository";
import { session } from "@/lib/server/security";
import { AppError } from "@/lib/server/errors";
async function OwnedDrafts() {
  await connection();
  let drafts: Awaited<ReturnType<typeof listDrafts>>;
  try {
    const owner = await session();
    await rate("read", owner, ipKey(new Request("http://localhost", { headers: await headers() })));
    drafts = await listDrafts(owner);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) return <DraftList initial={[]} />;
    return <div role="alert"><p>Your drafts could not be loaded right now. Try again.</p><a href="/drafts">Try again</a></div>;
  }
  return <DraftList initial={drafts} />;
}
export default function Drafts() {
  return (
    <>
      <h1>My drafts</h1>
      <Suspense fallback={<p>Opening drafts…</p>}>
        <OwnedDrafts />
      </Suspense>
    </>
  );
}
