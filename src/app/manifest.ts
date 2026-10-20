import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mixtape",
    short_name: "Mixtape",
    description: "Send a friend a film, a book and an artist from your own favourites, matched to their tastes.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f1e7",
    theme_color: "#f4f1e7",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
