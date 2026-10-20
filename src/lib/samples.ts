import type { Draft, Entity, Kind } from "./domain";
const now = "2026-10-17T00:00:00.000Z";
const filmNotes = [
  "I love how much can happen when two people just keep talking.",
  "I watched this slowly. I still think about the colours.",
  "This is the one I put on when I want to notice small things again.",
];
const bookNotes = [
  "I read a city at a time, then stop and picture it.",
  "This little book made ordinary rooms feel different to me.",
  "I liked letting this one stay strange instead of trying to explain it.",
];
const artistNotes = [
  "This is who I come back to when I want the evening to slow down.",
  "I keep finding another part to listen to.",
  "I like following where they take a rhythm.",
];
const otherNotes: Record<string, string[]> = {
  "a-little-more-soul": [
    "I love the quiet kindness under all those office jokes.",
    "The first time they make a song together is the bit I keep replaying.",
    "I came for the jokes and stayed for this unlikely little family.",
    "The record-shop arguments made me laugh at my own very serious lists.",
    "I like how the neighbours keep interrupting his plans to be left alone.",
    "I open this when I need the universe to take itself less seriously.",
    "He can make a simple line feel like something a friend just told you.",
    "I keep getting caught between listening to her voice and following the guitar.",
    "I love how the rhythm can lift you while the words ask you to pay attention.",
  ],
  "stranger-worlds": [
    "I kept thinking about that lonely room long after the credits.",
    "The disappearing rooms are what stayed with me. I want to know what stayed with you.",
    "I love the doorway between the ordinary world and the frightening one.",
    "The long journey across the ice is the part I wanted to talk about afterwards.",
    "I liked being unable to trust my own picture of the place.",
    "I kept following the loose threads, even when I could not see where they led.",
    "I put this on for the spaces between the sounds as much as the sounds themselves.",
    "I like how a small sound can make the whole room feel different.",
    "I stop trying to translate anything and just follow the rise of it.",
  ],
};
export const samples = [
  {
    id: "quiet-evenings",
    title: "Quiet evenings",
    sender: "Maya",
    recipient: "Leo",
    line: "A few things I keep coming back to. I wanted you to have them too.",
    shelf: [
      ["Before Sunrise", "Paris, Texas", "Amélie"],
      [
        "Invisible Cities — Italo Calvino",
        "Kitchen — Banana Yoshimoto",
        "The Ocean at the End of the Lane — Neil Gaiman",
      ],
      ["Nujabes", "Khruangbin", "BADBADNOTGOOD"],
    ],
    tastes: [
      "Spirited Away",
      "The Little Prince — Antoine de Saint-Exupéry",
      "Bon Iver",
    ],
  },
  {
    id: "a-little-more-soul",
    title: "A little more soul",
    sender: "Sam",
    recipient: "Jo",
    line: "For the next time you ask what I have been into.",
    shelf: [
      ["The Apartment", "Sing Street", "Hunt for the Wilderpeople"],
      [
        "High Fidelity — Nick Hornby",
        "A Man Called Ove — Fredrik Backman",
        "The Hitchhiker’s Guide to the Galaxy — Douglas Adams",
      ],
      ["Bill Withers", "Lianne La Havas", "Curtis Mayfield"],
    ],
    tastes: [
      "When Harry Met Sally…",
      "The Little Prince — Antoine de Saint-Exupéry",
      "Bon Iver",
    ],
  },
  {
    id: "stranger-worlds",
    title: "Stranger worlds",
    sender: "Noor",
    recipient: "Alex",
    line: "Three things I would like to talk about with you afterwards.",
    shelf: [
      ["Moon", "Eternal Sunshine of the Spotless Mind", "Pan’s Labyrinth"],
      [
        "The Left Hand of Darkness — Ursula K. Le Guin",
        "Annihilation — Jeff VanderMeer",
        "The Wind-Up Bird Chronicle — Haruki Murakami",
      ],
      ["Portishead", "Massive Attack", "Sigur Rós"],
    ],
    tastes: ["Arrival", "Piranesi — Susanna Clarke", "Radiohead"],
  },
] as const;
const categories: Kind[] = ["movie", "book", "artist"];
function entity(name: string, kind: Kind, id: string): Entity {
  const [title, author] = name.split(" — ");
  return {
    id: `fixture:${id}`,
    name: title,
    kind,
    detail: author ?? "Fictional sample identity",
    mode: "fixture",
    fetchedAt: now,
  };
}
export const sampleCatalog: Entity[] = samples.flatMap((s) => [
  ...s.shelf.flatMap((group, i) =>
    group.map((n, j) => entity(n, categories[i], `${s.id}:${i}:${j}`)),
  ),
  ...s.tastes.map((n, i) => entity(n, categories[i], `${s.id}:taste:${i}`)),
]);
export function sampleDraft(
  id: string,
  owner: string,
): Pick<
  Draft,
  | "sampleId"
  | "shelf"
  | "tastes"
  | "sender"
  | "recipient"
  | "introduction"
  | "mode"
> {
  const s = samples.find((s) => s.id === id);
  if (!s) throw new Error("This sample is unavailable.");
  return {
    sampleId: s.id,
    mode: "fixture",
    sender: s.sender,
    recipient: s.recipient,
    introduction: s.line,
    shelf: sampleCatalog
      .filter(
        (e) => e.id.startsWith(`fixture:${s.id}:`) && !e.id.includes(":taste:"),
      )
      .map((e, i) => ({
        entity: e,
        note:
          id === "quiet-evenings"
            ? [...filmNotes, ...bookNotes, ...artistNotes][i]
            : otherNotes[id][i],
        noteAuthor: "fictional_editor" as const,
        noteAuthoredAt: now,
        confirmedFavourite: true,
        confirmedBySession: owner,
      })),
    tastes: sampleCatalog.filter((e) =>
      e.id.startsWith(`fixture:${s.id}:taste:`),
    ),
  };
}
export const comparisonCases = [
  ...samples.map((s) => ({ id: s.id, title: s.title })),
  {
    id: "quiet-evenings-other-tastes",
    title: "Quiet evenings, different tastes",
  },
  { id: "known-low-coverage", title: "Known items and low coverage" },
];
export const heldOutCases = [
  "ambiguous-book-edition",
  "ambiguous-film-title",
  "missing-artist",
  "empty-books",
  "all-known-films",
  "wrong-type-result",
  "out-of-pool-result",
  "partial-coverage",
  "two-category-format",
  "kept-item-excluded",
];
