import type { Entity } from "./domain";

// Editorial entry points, independent of Qloo's artist selection. No playback
// or availability promise; uncurated identities link to an explicit search.
const tracks: Record<string, { label: string; href: string }> = {
  "Curtis Mayfield": { label: "Try Move On Up", href: "https://soundcloud.com/curtismayfield/move-on-up-1" },
  "Portishead": { label: "Try Glory Box", href: "https://soundcloud.com/portishead-official/glory-box" },
  "Massive Attack": { label: "Try Teardrop", href: "https://music.apple.com/us/song/724350661" },
  "Lianne La Havas": { label: "Try Green & Gold", href: "https://www.youtube.com/watch?v=qnogG7IMj8o" },
  "Sigur Rós": { label: "Try Svefn-g-englar", href: "https://sigurros.com/film/svefn-g-englar/" },
  "Bill Withers": { label: "Try Lovely Day", href: "https://www.youtube.com/watch?v=bEeaS6fuUoA" },
  Nujabes: { label: "Try Feather", href: "https://open.spotify.com/track/4aK4LNijbD7kkCg54UoIij" },
  Khruangbin: { label: "Try Friday Morning", href: "https://khruangbin.bandcamp.com/track/friday-morning" },
  BADBADNOTGOOD: { label: "Try Time Moves Slow", href: "https://badbadnotgoodofficial.bandcamp.com/track/time-moves-slow-feat-sam-herring" },
};
export function firstStep(entity: Entity) {
  const detail = /Fictional sample identity|Details unavailable/.test(entity.detail) ? "" : entity.detail;
  if (entity.kind === "artist") return { caption: "Start with a track", ...(tracks[entity.name] ?? { label: "Find a track to try", href: entity.destination ?? `https://open.spotify.com/search/${encodeURIComponent(entity.name)}` }) };
  if (entity.name === "Invisible Cities" && entity.kind === "book") return { caption: "Look inside the book", label: "Meet Marco Polo’s imagined cities", href: "https://www.penguin.co.uk/books/357001/invisible-cities-by-calvino-italo/9780099429838" };
  if (entity.name === "The Ocean at the End of the Lane" && entity.kind === "book") return { caption: "Read the opening", label: "Read the opening excerpt", href: "https://www.theguardian.com/books/2013/jun/10/extract-ocean-end-lane-neil-gaiman" };
  if (entity.name === "Amélie" && entity.kind === "movie") return { caption: "Start with the trailer", label: "Watch the official Amélie trailer", href: "https://www.youtube.com/watch?v=Py7cDXQae2U" };
  if (entity.name === "The Wind-Up Bird Chronicle" && entity.kind === "book") return { caption: "Look inside the book", label: "Follow the search for a missing cat", href: "https://www.penguinrandomhouse.com/books/118727/the-wind-up-bird-chronicle-by-haruki-murakami/" };
  if (entity.name === "High Fidelity" && entity.kind === "book") return { caption: "Look inside the book", label: "Meet Rob and his record shop", href: "https://www.penguinrandomhouse.com/books/318696/high-fidelity-by-nick-hornby/" };
  if (entity.name === "The Left Hand of Darkness" && entity.kind === "book") return { caption: "Look inside the book", label: "Enter the world of Winter", href: "https://www.penguinrandomhouse.com/books/538943/the-left-hand-of-darkness-by-ursula-k-le-guin/" };
  if (entity.kind === "movie") return { caption: "Find a trailer", label: "Search for the official trailer", href: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${entity.name} ${detail} official trailer`)}` };
  return { caption: "Find a book preview", label: "Search Google Books", href: `https://books.google.com/books?q=${encodeURIComponent(`${entity.name} ${detail}`)}` };
}
