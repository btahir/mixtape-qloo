import type { NextConfig } from "next";
const config: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      // Only private surfaces stay out of search. The homepage and info pages are indexable.
      ...["/api/:path*", "/make/:path*", "/m/:path*", "/drafts"].map((source) => ({
        source, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      })),
      ...["/api/:path*", "/make/:path*", "/m/:path*", "/drafts", "/compare/:path*"].map((source) => ({
        source, headers: [{ key: "Cache-Control", value: "private, no-store" }],
      })),
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/grain-:hash.svg", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    ];
  },
};
export default config;
