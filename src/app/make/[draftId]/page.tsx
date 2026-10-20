import { connection } from "next/server";
import { headers } from "next/headers";
import { rate } from "@/lib/server/limits";
import { ipKey } from "@/lib/server/security";
import Link from "next/link";
import { Suspense } from "react";
import { AppError } from "@/lib/server/errors";
import { owned } from "@/lib/server/repository";
import { session } from "@/lib/server/security";
import { tasteExample } from "@/lib/server/taste-example";
import { Composer } from "@/components/composer";
async function Content({ params, searchParams }: { params: Promise<{ draftId: string }>; searchParams: Promise<{ opening?: string }> }) {
  await connection();
  let draft;
  try {
    const owner = await session();
    await rate("read", owner, ipKey(new Request("http://localhost", { headers: await headers() })));
    draft = await owned((await params).draftId, owner);
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 403) return <div role="alert"><h1>Your draft could not be loaded.</h1><p>Try again. Your saved version is still here.</p><a href={`/make/${(await params).draftId}`}>Try again</a></div>;
  }
  return draft ? (
    <Composer initial={draft} example={draft.sampleId ? await tasteExample().catch(() => undefined) : undefined} openGift={(await searchParams).opening === "1"} />
  ) : (
    <>
      <h1>This browser cannot edit that draft.</h1>
      <p>Open a shared link, or start a new mixtape.</p>
      <Link href="/">Make a mixtape</Link>
    </>
  );
}
export default function Make(props: { params: Promise<{ draftId: string }>; searchParams: Promise<{ opening?: string }> }) {
  return (
    <Suspense fallback={<p>Opening your draft…</p>}>
      <Content {...props} />
    </Suspense>
  );
}
