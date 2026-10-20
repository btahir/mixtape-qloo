"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section>
      <h1>This view could not be opened.</h1>
      <p>Your saved version is still available.</p>
      <button onClick={reset}>Try again</button>
      <Link prefetch={false} href="/">
        Back to Mixtape
      </Link>
    </section>
  );
}
