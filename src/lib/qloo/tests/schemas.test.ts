import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  responseSchemas,
  entitySchema,
  entityKinds,
  calendarDateSchema,
  entityInsightsResponseSchema,
  searchResponseSchema,
  tagsResponseSchema,
  demographicsResponseSchema,
} from "../schemas";
import { QlooClient, QLOO_ORIGIN } from "../client";
import { FixtureTransport } from "../fixture-transport";

const fixtureDir = new URL("../fixtures/", import.meta.url);
const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, fixtureDir), "utf8"));
const seed = "f0000000-0000-4000-8000-000000000001";
const schemas = {
  "entities.json": responseSchemas.entities,
  "tags.json": responseSchemas.tags,
  "tag-types.json": responseSchemas.tagTypes,
  "demographics.json": responseSchemas.demographics,
  "heatmap.json": responseSchemas.heatmap,
  "compare.json": responseSchemas.compare,
  "trending.json": responseSchemas.trending,
};
describe("documented wire contracts", () => {
  for (const name of readdirSync(fixtureDir).filter((n) => n.endsWith(".json")))
    it(`parses synthetic ${name}`, () => {
      const schema = name.startsWith("insights-")
        ? entityInsightsResponseSchema
        : schemas[name as keyof typeof schemas];
      expect(schema.safeParse(read(name)).success).toBe(true);
      expect((read(name) as Record<string, unknown>).fixture).toBe(true);
    });
  it("accepts flat/nested metadata, null, zero and unknown metadata without dropping them", () => {
    const value = entitySchema.parse({
      id: seed,
      name: "Fixture",
      properties: { description: null, future_metric: 7 },
      affinity: 0,
      popularity: 0,
      query: { affinity: 0, new_value: 9 },
      new_field: "retained",
    });
    expect(value).toMatchObject({
      id: seed,
      properties: { description: null, future_metric: 7 },
      affinity: 0,
      popularity: 0,
      query: { new_value: 9 },
      new_field: "retained",
    });
  });
  it("supports top-level and nested duration and omitted success", () => {
    expect(
      entityInsightsResponseSchema.parse({
        results: { entities: [], duration: 9 },
        duration: 10,
      }),
    ).toMatchObject({ results: { duration: 9 }, duration: 10 });
    expect(searchResponseSchema.parse({ results: [] }).results).toEqual([]);
  });
  it.each([
    { results: {} },
    { results: null },
    { results: { entities: null } },
    { results: { entities: {} } },
    { results: { tags: [] } },
  ])("rejects a missing/wrong entity collection: %j", (input) => {
    expect(entityInsightsResponseSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    { name: "No identity" },
    { entity_id: "guessed", name: "Bad ID" },
    { entity_id: seed },
    { entity_id: seed, name: "", query: {} },
    { id: seed, name: "Bad score", affinity: 91 },
    { id: seed, name: "NaN", popularity: NaN },
    { id: seed, name: "Infinity", query: { affinity: Infinity } },
  ])("rejects malformed entity: %j", (value) => {
    expect(entitySchema.safeParse(value).success).toBe(false);
  });
  it("keeps lookup vs Insights envelopes distinct and accepts genuine emptiness", () => {
    expect(
      searchResponseSchema.safeParse({ results: { entities: [] } }).success,
    ).toBe(false);
    expect(
      entityInsightsResponseSchema.parse({
        success: true,
        results: { entities: [] },
      }).results.entities,
    ).toEqual([]);
  });
  it("parses both tag identities and empty query metadata", () => {
    const result = tagsResponseSchema.parse(read("tags.json"));
    expect(result.results.tags[0]?.id).toBeTruthy();
    expect(result.results.tags[1]?.tag_id).toBeTruthy();
    expect(result.results.tags[1]?.query).toEqual({});
  });
  it("preserves signed demographic values and tag identifiers", () => {
    const data = demographicsResponseSchema.parse({
      results: {
        demographics: [
          {
            entity_id: "urn:tag:genre:media:action",
            query: {
              age: { "25_to_29": -0.53 },
              gender: { female: 0.16, male: -0.16 },
            },
          },
        ],
      },
    });
    expect(data.results.demographics[0]?.query.age?.["25_to_29"]).toBe(-0.53);
  });
  it("rejects a failed success flag, out-of-range heatmap coordinates, and missing opaque results", () => {
    expect(
      searchResponseSchema.safeParse({ success: false, results: [] }).success,
    ).toBe(false);
    expect(
      responseSchemas.heatmap.safeParse({
        results: {
          heatmap: [{ location: { latitude: 91, longitude: 0 }, query: {} }],
        },
      }).success,
    ).toBe(false);
    expect(responseSchemas.tagTypes.safeParse({ success: true }).success).toBe(
      false,
    );
    expect(
      responseSchemas.compare.parse({
        results: [{ unknown_comparison_metric: 3 }],
      }).results,
    ).toEqual([{ unknown_comparison_metric: 3 }]);
  });
  it.each(["2024-02-29", "2026-10-17"])("accepts calendar date %s", (value) =>
    expect(calendarDateSchema.safeParse(value).success).toBe(true),
  );
  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01"])(
    "rejects calendar date %s",
    (value) => expect(calendarDateSchema.safeParse(value).success).toBe(false),
  );
});

describe("offline transport", () => {
  const client = () =>
    new QlooClient({ origin: QLOO_ORIGIN, transport: new FixtureTransport() });
  it.each(entityKinds)("runs %s Insights without a key", async (kind) => {
    const result = await client().insights({
      "filter.type": `urn:entity:${kind}`,
      "signal.interests.entities": [seed],
    });
    expect(result.provenance.source).toBe("fixture");
    expect(result.data.fixture).toBe(true);
    expect(result.data.results.entities).toHaveLength(2);
  });
  it("searches, hydrates, ranks shortlists, and excludes deterministically", async () => {
    const c = client();
    const search = await c.searchEntities({
      query: "Spirited",
      types: ["urn:entity:movie"],
    });
    expect(search.data.results[0]?.entity_id).toBe(seed);
    expect(
      (await c.getEntities({ entity_ids: [seed] })).data.results,
    ).toHaveLength(1);
    const ranked = await c.insights({
      "filter.type": "urn:entity:movie",
      "signal.interests.entities": [seed],
      "filter.results.entities": [seed],
    });
    expect(ranked.data.results.entities).toHaveLength(1);
    expect(
      (
        await c.insights({
          "filter.type": "urn:entity:movie",
          "signal.interests.entities": [seed],
          "filter.results.entities": [seed],
          "filter.exclude.entities": [seed],
        })
      ).data.results.entities,
    ).toEqual([]);
  });
  it("runs tag, demographic, heatmap, compare, tag-type and trend operations", async () => {
    const c = client();
    expect(
      (await c.findTags({ "filter.query": "Mystery" })).data.results.tags,
    ).toHaveLength(1);
    expect(
      (
        await c.insights({
          "filter.type": "urn:tag",
          "signal.interests.entities": [seed],
        })
      ).data.results.tags.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await c.insights({
          "filter.type": "urn:demographics",
          "signal.interests.tags": ["urn:tag:genre:media:fantasy"],
        })
      ).data.results.demographics,
    ).toHaveLength(1);
    expect(
      (
        await c.insights({
          "filter.type": "urn:heatmap",
          "filter.location.query": "New York",
          "signal.interests.entities": [seed],
        })
      ).data.results.heatmap,
    ).toHaveLength(2);
    expect(
      (
        await c.compare({
          "a.signal.interests.entities": [seed],
          "b.signal.interests.entities": [seed],
        })
      ).data.results,
    ).toEqual([]);
    expect((await c.getTagTypes()).data.results).toBeDefined();
    expect(
      (
        await c.trending({
          "filter.type": "urn:entity:movie",
          "signal.interests.entities": [seed],
          "filter.start_date": "2026-10-01",
          "filter.end_date": "2026-10-08",
        })
      ).data.results.trending,
    ).toHaveLength(1);
  });
  it("rejects unsupported fixture filters without falling back to a live API", async () => {
    await expect(
      client().insights({
        "filter.type": "urn:entity:place",
        "signal.interests.entities": [seed],
        "filter.price_level.max": 2,
      }),
    ).rejects.toMatchObject({ kind: "input", status: 400 });
  });
});
