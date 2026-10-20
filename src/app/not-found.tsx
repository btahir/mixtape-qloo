import Link from "next/link";
export default function NotFound() {
  return (
    <>
      <h1>This mixtape is no longer available.</h1>
      <Link prefetch={false} href="/">
        Make a mixtape
      </Link>
    </>
  );
}
