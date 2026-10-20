/** The canonical public origin, without a trailing slash. */
export const siteOrigin = () => (process.env.APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
export const siteTitle = "Mixtape · Send a friend a film, a book and an artist you love";
export const siteDescription =
  "Choose a film, a book and an artist from your own favourites, matched to a friend’s tastes with Qloo. Add a note to each, and they can send one back.";
/** Private pages: drafts, gift links and anything tied to one browser. */
export const privatePage = { index: false, follow: false, noarchive: true, nocache: true } as const;
