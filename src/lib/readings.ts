import type { Entity, Slot } from "./domain";

// Reviewed descriptions of the PICK, not claims that Qloo reports themes.
// The model may choose a detail; it cannot invent one or reverse taste roles.
const facts: Record<string, { kind: Entity["kind"]; clauses: string[]; source: string }> = {
  "Amélie": { kind: "movie", clauses: ["a Parisian matchmaker quietly changing other people's lives", "a heroine with an elaborate imaginary world"], source: "https://player.bfi.org.uk/subscription/film/watch-amelie-2001-online" },
  "Invisible Cities": { kind: "book", clauses: ["imaginary cities told by Marco Polo", "a journey through cities that keeps returning to Venice"], source: "https://www.penguin.co.uk/books/357001/invisible-cities-by-calvino-italo/9780099429838" },
  "The Ocean at the End of the Lane": { kind: "book", clauses: ["a childhood memory that opens into the impossible"], source: "https://journal.neilgaiman.com/2012/10/the-ocean-at-end-of-lane-other-bits-of.html" },
  "Khruangbin": { kind: "artist", clauses: ["a Texas trio with roots in Thai funk", "bass-led psychedelia with surf-rock touches"], source: "https://khruangbin.bandcamp.com/track/friday-morning" },
  "Sing Street": { kind: "movie", clauses: ["a Dublin schoolboy starts a band in the 1980s"], source: "https://lionsgatelimited.com/products/sing-street-4k-collectors-set" },
  "High Fidelity": { kind: "book", clauses: ["a record-shop owner sorts through music and heartbreak"], source: "https://www.penguinrandomhouse.com/books/318696/high-fidelity-by-nick-hornby/" },
  "Lianne La Havas": { kind: "artist", clauses: ["Green & Gold is a place to begin listening"], source: "https://www.youtube.com/watch?v=qnogG7IMj8o" },
  "Moon": { kind: "movie", clauses: ["an astronaut nears the end of three years on the Moon"], source: "https://www.sonyclassics.com/moon/moon_presskit.pdf" },
  "The Left Hand of Darkness": { kind: "book", clauses: ["an envoy tries to understand an unfamiliar frozen world"], source: "https://www.ursulakleguin.com/left-hand-darkness" },
  "Sigur Rós": { kind: "artist", clauses: ["their album ( ) is sung without lyrics"], source: "https://sigurros.com/news/2002/album-info/" },
  "Bill Withers": { kind: "artist", clauses: ["Lovely Day is a place to begin listening"], source: "https://www.youtube.com/watch?v=bEeaS6fuUoA" },
  "Kitchen": { kind: "book", clauses: ["a young woman finds a new family in the wake of loss"], source: "https://groveatlantic.com/book/kitchen/" },
  "The Wind-Up Bird Chronicle": { kind: "book", clauses: ["a missing cat leads into a mystery beneath Tokyo"], source: "https://www.penguinrandomhouse.com/books/118727/the-wind-up-bird-chronicle-by-haruki-murakami/" },
  "Eternal Sunshine of the Spotless Mind": { kind: "movie", clauses: ["two former lovers try to erase each other from memory"], source: "https://www.focusfeatures.com/eternal_sunshine_of_the_spotless_mind" },

};
export function readingFact(entity: Entity) {
  const fact = facts[entity.name];
  return fact?.kind === entity.kind ? fact : undefined;
}
export function readingText(signal: Entity, pick: Entity, detail?: string) {
  const connection = `Qloo connects ${signal.name} with ${pick.name}.`;
  return detail ? `${connection} ${detail[0].toUpperCase()}${detail.slice(1)}.` : connection;
}
export function supportedDetail(pick: Entity, proposed?: string) {
  return proposed && readingFact(pick)?.clauses.includes(proposed) ? proposed : undefined;
}
export function reportedSignal(slot: Slot) {
  const e = slot.evidence;
  if (e.mode !== "live" || e.explanationStatus !== "verified" || slot.previousTastes || slot.previousShelf) return undefined;
  const signals = [...(e.contributions ?? [])].filter((c) => c.score > 0).sort((a, b) => b.score - a.score)
    .flatMap((c) => e.signals.filter((s) => s.id.toUpperCase() === c.entityId.toUpperCase() && s.kind !== slot.kind));
  return signals.find((s) => s.id === e.highlightedSignalId) ?? signals[0];
}
// Never display a legacy free-form interpretation, even on an old shared gift.
export function safeReading(slot: Slot) {
  const signal = reportedSignal(slot);
  return signal ? readingText(signal, slot.entity, supportedDetail(slot.entity, slot.evidence.readingDetail)) : undefined;
}
