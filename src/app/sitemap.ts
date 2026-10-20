import type { MetadataRoute } from "next";
import { comparisonCases } from "@/lib/samples";
import { siteOrigin } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return [
    { url: origin, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/connections`, changeFrequency: "monthly", priority: 0.6 },
    ...comparisonCases.map((c) => ({ url: `${origin}/compare/${c.id}`, changeFrequency: "monthly" as const, priority: 0.4 })),
  ];
}
