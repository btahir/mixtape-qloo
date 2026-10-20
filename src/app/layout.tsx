import Link from "next/link";
import type { Metadata, Viewport } from "next";
import { EARLY_CLICK_SCRIPT } from "@/components/early-click";
import { siteDescription, siteOrigin, siteTitle } from "@/lib/site";
import { How } from "@/components/landing";
import { Network } from "@/components/network";
import { Mark } from "@/components/print";
import "./globals.css";
import { Suspense } from "react";
import { connection } from "next/server";
async function SourceNotice() {
  await connection();
  return process.env.QLOO_MODE === "fixture" || (!process.env.QLOO_API_KEY && process.env.QLOO_MODE !== "live") ? <p className="notice">Sample mode · No live Qloo calls</p> : process.env.MIXTAPE_AGENT_MODE === "deterministic" ? <p className="notice">Outage fallback · Qloo choices without the language agent</p> : null;
}
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: { default: siteTitle, template: "%s · Mixtape" },
  description: siteDescription,
  applicationName: "Mixtape",
  // Indexable by default; drafts, gift links and other private pages opt out.
  robots: { index: true, follow: true },
  openGraph: { type: "website", siteName: "Mixtape", locale: "en_GB", title: siteTitle, description: siteDescription },
  twitter: { card: "summary_large_image", title: siteTitle, description: siteDescription },
  referrer: "no-referrer",
};
export const viewport: Viewport = { themeColor: "#f4f1e7" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: EARLY_CLICK_SCRIPT }} />
        {[
          "bricolage-grotesque-normal-85f55a58a3",
          "dm-sans-normal-468d56b6b2",
          "instrument-serif-italic-6ee678c33f",
        ].map((font) => (
          <link
            key={font}
            rel="preload"
            href={`/fonts/${font}.woff2`}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header>
        <div className="site-header">
          <Link prefetch={false} href="/" className="wordmark">
            <Mark />
            Mixtape<span className="brand-dot">.</span>
          </Link>
          <nav>
            <Link prefetch={false} href="/drafts">
              My drafts
            </Link>
            <How />
          </nav>
        </div>
        <Suspense fallback={null}><SourceNotice /></Suspense>
        </header>
        <Network />
        <main id="main">{children}</main>
        <footer className="site-footer">
          <Link prefetch={false} href="/drafts">Saved drafts</Link>
          <Mark />
          <span>Nothing sends automatically.</span>
        </footer>
      </body>
    </html>
  );
}
