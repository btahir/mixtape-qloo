import { expect, it } from "vitest";
import { safeReading, supportedDetail } from "@/lib/readings";
import type { Slot, Entity } from "@/lib/domain";
const entity = (id: string, name: string, kind: Entity["kind"]): Entity => ({ id, name, kind, detail: "", fetchedAt: "", mode: "live" });
const signal = entity("signal", "Spirited Away", "movie");
const pick = entity("pick", "The Ocean at the End of the Lane", "book");
function slot(): Slot { return { kind: "book", entity: pick, note: "", locked: false, method: "qloo", previousTastes: false, previousShelf: false, evidence: { mode: "live", category: "book", signals: [signal], fingerprint: "", eligibleCount: 2, returnedCount: 2, missingCount: 0, rejectedCount: 0, rank: 1, selectedId: "pick", score: .7, fetchedAt: "", cache: "hit", schema: "", warnings: [], explanationStatus: "verified", contributions: [{ entityId: "signal", score: .6 }] } }; }
it.each([
  "Your taste for The Ocean at the End of the Lane opens a door to film: Spirited Away shares its dreamlike, child-led journey into a world just beside our own.",
  "Your taste for The Ocean at the End of the Lane pairs well with Spirited Away.",
  "Your taste for Sing Street pairs with The Little Prince.",
])("never displays a reversed legacy reading: %s", (interpretation) => {
  const s = slot(); s.evidence.interpretation = interpretation;
  expect(safeReading(s)).toMatch(/^Qloo connects Spirited Away with/);
  expect(safeReading(s)).not.toContain("Your taste for");
  expect(supportedDetail(pick, interpretation)).toBeUndefined();
});
it("uses only a supported pick detail and a positive current cross-category edge", () => {
  const s = slot(); s.evidence.readingDetail = "a childhood memory that opens into the impossible";
  expect(safeReading(s)).toBe("Qloo connects Spirited Away with The Ocean at the End of the Lane. A childhood memory that opens into the impossible.");
  s.evidence.readingDetail = "directed by an invented director";
  expect(safeReading(s)).not.toContain("director");
  s.evidence.contributions![0].score = 0; expect(safeReading(s)).toBeUndefined();
  s.evidence.contributions![0].score = 1; s.previousTastes = true; expect(safeReading(s)).toBeUndefined();
});
