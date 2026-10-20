import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";

// Gift links (/m/) stay crawlable so link previews work; their pages and headers say noindex.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/make/", "/drafts"] },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
