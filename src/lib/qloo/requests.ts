import { z } from "zod";
import {
  calendarDateSchema,
  entityIdSchema,
  entityKinds,
  entityTypeSchema,
  tagIdSchema,
  type InsightsType,
} from "./schemas";
import { inputError } from "./errors";

export type Primitive = string | number | boolean;
export type QueryValue = Primitive | readonly Primitive[] | undefined;
export type Query = Readonly<Record<string, QueryValue>>;
export type Endpoint =
  | "/search"
  | "/entities"
  | "/v2/insights"
  | "/v2/tags"
  | "/v2/tags/types"
  | "/v2/analysis/compare"
  | "/v2/trending";
const text = z.string().trim().min(1).max(2048);
const finite = z.number();
const strings = z.array(text).min(1).max(50);
const ids = z.array(entityIdSchema).min(1).max(50);
const tags = z.array(tagIdSchema).min(1).max(50);
const parentTypes = z
  .array(z.string().regex(/^urn:entity:[a-z_]+$/))
  .min(1)
  .max(50);
const score = finite.min(0).max(1);
const radius = finite.int().min(0).max(800_000);
const operator = z.enum(["union", "intersection"]);
const weight = z.union([
  finite.min(0),
  z.enum(["very_low", "low", "mid", "medium", "high", "very_high"]),
]);
const page = {
  take: finite.int().min(1).max(50).optional(),
  page: finite.int().min(1).max(100).optional(),
  offset: finite.int().min(0).optional(),
};
const signals = {
  "signal.interests.entities": ids.optional(),
  "signal.interests.entities.include": ids.optional(),
  "signal.interests.tags": tags.optional(),
  "operator.signal.interests.tags": operator.optional(),
  "signal.interests.entities.weight": weight.optional(),
  "signal.interests.tags.weight": weight.optional(),
  "signal.demographics.age": z
    .array(
      z.enum([
        "24_and_younger",
        "25_to_29",
        "30_to_34",
        "35_to_44",
        "45_to_54",
        "55_and_older",
        "35_and_younger",
        "36_to_55",
      ]),
    )
    .min(1)
    .max(8)
    .optional(),
  "signal.demographics.gender": z.enum(["male", "female"]).optional(),
  "signal.demographics.audiences": z
    .array(z.string().regex(/^urn:audience:[^\s,]+$/))
    .min(1)
    .max(50)
    .optional(),
  "signal.demographics.age.weight": weight.optional(),
  "signal.demographics.gender.weight": weight.optional(),
  "signal.demographics.audiences.weight": weight.optional(),
  "signal.location": text.optional(),
  "signal.location.query": text.optional(),
  "signal.location.radius": radius.optional(),
  "signal.location.weight": weight.optional(),
};
const geography = {
  "filter.location": text.optional(),
  "filter.location.query": text.optional(),
  "filter.location.radius": radius.optional(),
  "filter.exclude.location": text.optional(),
  "filter.exclude.location.query": text.optional(),
  "filter.exclude.location.radius": radius.optional(),
  "filter.location.geohash": text.optional(),
  "filter.exclude.location.geohash": text.optional(),
  "filter.location.metro": text.optional(),
  "filter.address": text.optional(),
  "filter.geocode.name": text.optional(),
  "filter.geocode.admin1_region": text.optional(),
  "filter.geocode.admin2_region": text.optional(),
  "filter.geocode.country_code": text.optional(),
};
const baseFilters = {
  "filter.exclude.entities": ids.optional(),
  "filter.results.entities": ids.optional(),
  "filter.results.entities.query": text.optional(),
  "filter.entities.query": text.optional(),
  "filter.tags": tags.optional(),
  "filter.exclude.tags": tags.optional(),
  "operator.filter.tags": operator.optional(),
  "operator.filter.exclude.tags": operator.optional(),
  "filter.exists": z
    .enum(["properties.image", "properties.description"])
    .optional(),
  "filter.external.exists": z
    .array(z.enum(["resy", "michelin", "tablet"]))
    .min(1)
    .optional(),
  "operator.filter.external.exists": operator.optional(),
  "filter.parents.types": parentTypes.optional(),
  "filter.popularity.min": score.optional(),
  "filter.popularity.max": score.optional(),
};
const placeFilters = {
  ...geography,
  "filter.price_level.min": finite.int().min(1).max(4).optional(),
  "filter.price_level.max": finite.int().min(1).max(4).optional(),
  "filter.price_range.from": finite.int().min(0).max(1_000_000).optional(),
  "filter.price_range.to": finite.int().min(0).max(1_000_000).optional(),
  "filter.hotel_class.min": finite.int().min(1).max(5).optional(),
  "filter.hotel_class.max": finite.int().min(1).max(5).optional(),
  "filter.properties.business_rating.min": finite.min(1).max(5).optional(),
  "filter.properties.business_rating.max": finite.min(1).max(5).optional(),
  "filter.hours": z
    .enum([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ])
    .optional(),
  "filter.references_brand": ids.optional(),
  "operator.filter.references_brand": operator.optional(),
  "filter.external.resy.count.min": finite.int().min(0).optional(),
  "filter.external.resy.count.max": finite.int().min(0).optional(),
  "filter.external.resy.party_size.min": finite.int().min(1).optional(),
  "filter.external.resy.party_size.max": finite.int().min(1).optional(),
  "filter.external.resy.rating.min": finite.min(0).max(5).optional(),
  "filter.external.resy.rating.max": finite.min(0).max(5).optional(),
  "filter.external.tripadvisor.rating.count.min": finite
    .int()
    .min(0)
    .optional(),
  "filter.external.tripadvisor.rating.count.max": finite
    .int()
    .min(0)
    .optional(),
  "filter.external.tripadvisor.rating.min": finite.min(0).max(5).optional(),
  "filter.external.tripadvisor.rating.max": finite.min(0).max(5).optional(),
};
const screenFilters = {
  "filter.content_rating": z
    .array(
      z.enum([
        "G",
        "PG",
        "PG-13",
        "R",
        "NC-17",
        "TV-G",
        "TV-PG",
        "TV-14",
        "TV-MA",
        "TV-Y",
        "TV-Y7",
        "TV-Y7-FV",
        "Not Rated",
        "Unrated",
        "Approved",
        "Passed",
        "X",
        "GP",
        "M",
        "13+",
        "16+",
        "18+",
      ]),
    )
    .min(1)
    .optional(),
  "filter.release_year.min": finite.int().optional(),
  "filter.release_year.max": finite.int().optional(),
  "filter.release_date.min": calendarDateSchema.optional(),
  "filter.release_date.max": calendarDateSchema.optional(),
  "filter.release_country": strings.optional(),
  "operator.filter.release_country": operator.optional(),
  "filter.rating.min": finite.min(0).max(5).optional(),
  "filter.rating.max": finite.min(0).max(5).optional(),
};
const tvFilters = {
  "filter.finale_year.min": finite.int().optional(),
  "filter.finale_year.max": finite.int().optional(),
  "filter.latest_known_year.min": finite.int().optional(),
  "filter.latest_known_year.max": finite.int().optional(),
};
const bookFilters = {
  "filter.publication_year.min": finite.int().optional(),
  "filter.publication_year.max": finite.int().optional(),
};
const personFilters = {
  "filter.date_of_birth.min": calendarDateSchema.optional(),
  "filter.date_of_birth.max": calendarDateSchema.optional(),
  "filter.date_of_death.min": calendarDateSchema.optional(),
  "filter.date_of_death.max": calendarDateSchema.optional(),
  "filter.gender": text.optional(),
};
const heatmapFilters = {
  "output.heatmap.boundary": text.optional(),
  "heatmap.dimensions": z
    .array(z.enum(["quality", "popularity", "hotel_class", "price_level"]))
    .min(1)
    .optional(),
  "filter.dimensions.hotel_class": z
    .array(finite.int().min(1).max(5))
    .min(1)
    .optional(),
  "filter.dimensions.price_level": z
    .array(finite.int().min(1).max(4))
    .min(1)
    .optional(),
};
const insightsType = z.enum([
  ...entityKinds.map((k) => `urn:entity:${k}` as const),
  "urn:entity:destination",
  "urn:entity:locality",
  "urn:entity:video_game",
  "urn:tag",
  "urn:demographics",
  "urn:heatmap",
]);
export const insightsRequestSchema = z.strictObject({
  "filter.type": insightsType,
  ...page,
  ...signals,
  ...baseFilters,
  ...placeFilters,
  ...screenFilters,
  ...tvFilters,
  ...bookFilters,
  ...personFilters,
  ...heatmapFilters,
  "filter.results.tags": tags.optional(),
  "filter.tag.types": strings.optional(),
  "feature.explainability": z.boolean().optional(),
  "bias.trends": z
    .enum(["off", "very_low", "low", "mid", "medium", "high", "very_high"])
    .optional(),
  "bias.content_based": score.optional(),
  "bias.quality": z.union([finite.positive(), weight]).optional(),
  "diversify.by": z
    .enum(["properties.geocode.city", "properties.geocode.metro", "subtype"])
    .optional(),
  "diversify.take": finite.int().positive().optional(),
  "backfill.cross_domain.take": finite.int().min(1).max(20).optional(),
  "backfill.content_based.take": finite.int().min(1).max(10).optional(),
  sort_by: z.enum(["affinity", "distance", "rating", "quality"]).optional(),
});
export type InsightsRequest<T extends InsightsType = InsightsType> = Omit<
  z.input<typeof insightsRequestSchema>,
  "filter.type"
> & { "filter.type": T };
export const searchRequestSchema = z.strictObject({
  query: text.max(500),
  types: z
    .array(
      z.enum([
        ...entityKinds.map((k) => `urn:entity:${k}` as const),
        "urn:entity:actor",
        "urn:entity:album",
        "urn:entity:author",
        "urn:entity:director",
        "urn:entity:locality",
      ]),
    )
    .min(1)
    .optional(),
  take: page.take,
  page: page.page,
  "filter.location": text.optional(),
  "filter.radius": finite.min(0).max(100).optional(),
  "filter.exists": baseFilters["filter.exists"],
  "filter.tags": tags.optional(),
  "operator.filter.tags": operator.optional(),
  "filter.rating": finite.min(0).max(5).optional(),
  "filter.popularity": score.optional(),
  "filter.address": text.optional(),
  sort_by: z.enum(["match", "distance", "popularity"]).optional(),
});
export type SearchRequest = z.input<typeof searchRequestSchema>;
const externalProviders = [
  "facebook",
  "goodreads",
  "goodreads_author",
  "igdb",
  "imdb",
  "instagram",
  "isbn10",
  "isbn13",
  "itunes",
  "lastfm",
  "library_of_congress",
  "metacritic",
  "michelin",
  "musicbrainz",
  "rottentomatoes",
  "soundcloud",
  "spotify",
  "tablet",
  "twitch",
  "twitter",
  "wikidata",
  "resy",
] as const;
export type EntitiesRequest = { entity_ids?: readonly string[] } & Partial<
  Record<
    `external.${(typeof externalProviders)[number]}.ids`,
    readonly string[]
  >
>;
const entitiesRequestSchema = z
  .strictObject({
    entity_ids: ids.optional(),
    ...Object.fromEntries(
      externalProviders.map((p) => [`external.${p}.ids`, strings.optional()]),
    ),
  })
  .refine((q) => Object.values(q).some((v) => v !== undefined));
export const tagsRequestSchema = z.strictObject({
  take: page.take,
  page: page.page,
  "filter.query": text.optional(),
  "feature.semantic_search": z.boolean().optional(),
  "feature.typo_tolerance": z.boolean().optional(),
  "filter.results.tags": tags.optional(),
  "filter.parents.types": parentTypes.optional(),
  "filter.tag.types": strings.optional(),
  "filter.popularity.min": score.optional(),
  "filter.popularity.max": score.optional(),
});
export type TagsRequest = z.input<typeof tagsRequestSchema>;
export const tagTypesRequestSchema = z.strictObject({
  take: page.take,
  page: page.page,
  "filter.parents.types": parentTypes.optional(),
});
export type TagTypesRequest = z.input<typeof tagTypesRequestSchema>;
export const compareRequestSchema = z.strictObject({
  ...page,
  "a.signal.interests.entities": ids,
  "b.signal.interests.entities": ids,
  "filter.type": z.array(entityTypeSchema).min(1).optional(),
  "filter.entities.query": text.optional(),
  "filter.location.query": text.optional(),
  "filter.location.radius": radius.optional(),
  "filter.exclude.location.query": text.optional(),
  "filter.exclude.location.radius": radius.optional(),
  "filter.subtype": z.enum(["urn:tag:occupation", "urn:tag:genre"]).optional(),
  model: z.enum(["descriptive", "predictive"]).optional(),
});
export type CompareRequest = z.input<typeof compareRequestSchema>;
export const trendingRequestSchema = z.strictObject({
  ...page,
  "filter.type": entityTypeSchema,
  "signal.interests.entities": z.array(entityIdSchema).length(1),
  "filter.start_date": calendarDateSchema,
  "filter.end_date": calendarDateSchema,
});
export type TrendingRequest = z.input<typeof trendingRequestSchema>;
const validators = {
  "/search": searchRequestSchema,
  "/entities": entitiesRequestSchema,
  "/v2/insights": insightsRequestSchema,
  "/v2/tags": tagsRequestSchema,
  "/v2/tags/types": tagTypesRequestSchema,
  "/v2/analysis/compare": compareRequestSchema,
  "/v2/trending": trendingRequestSchema,
} as const;

export function validateQuery(
  endpoint: Endpoint,
  input: unknown,
  compatibility = false,
): Query {
  const parsed = validators[endpoint].safeParse(input);
  if (!parsed.success) throw inputError();
  const q = parsed.data as Record<string, QueryValue>;
  if (q.page !== undefined && q.offset !== undefined) throw inputError();
  for (const [key, value] of Object.entries(q)) {
    const pair = key.endsWith(".min")
      ? key.slice(0, -4) + ".max"
      : key.endsWith(".from")
        ? key.slice(0, -5) + ".to"
        : undefined;
    if (
      pair &&
      value !== undefined &&
      q[pair] !== undefined &&
      value > q[pair]!
    )
      throw inputError();
  }
  if (
    endpoint === "/v2/trending" &&
    String(q["filter.start_date"]) > String(q["filter.end_date"])
  )
    throw inputError();
  if (endpoint === "/v2/insights") {
    const type = String(q["filter.type"]);
    if (
      !compatibility &&
      [
        "urn:entity:destination",
        "urn:entity:locality",
        "urn:entity:video_game",
      ].includes(type)
    )
      throw inputError();
    const groups: [object, string[]][] = [
      [
        placeFilters,
        [
          "urn:entity:place",
          "urn:heatmap",
          "urn:entity:destination",
          "urn:entity:locality",
        ],
      ],
      [screenFilters, ["urn:entity:movie", "urn:entity:tv_show"]],
      [tvFilters, ["urn:entity:tv_show"]],
      [bookFilters, ["urn:entity:book"]],
      [personFilters, ["urn:entity:person"]],
      [heatmapFilters, ["urn:heatmap"]],
    ];
    for (const [fields, allowed] of groups)
      if (
        !allowed.includes(type) &&
        Object.keys(fields).some((k) => q[k] !== undefined)
      )
        throw inputError();
    if (
      q["bias.quality"] !== undefined &&
      type !== "urn:entity:place" &&
      type !== "urn:heatmap"
    )
      throw inputError();
    if (q["bias.quality"] === 0) throw inputError();
    if (q.sort_by === "quality" && type !== "urn:entity:place")
      throw inputError();
    if (
      q.sort_by === "distance" &&
      q["filter.location"] === undefined &&
      q["filter.location.query"] === undefined
    )
      throw inputError();
    const meaningful = Object.keys(q).some(
      (k) =>
        q[k] !== undefined &&
        ((k.startsWith("signal.") &&
          !k.endsWith(".weight") &&
          !k.endsWith(".radius") &&
          k !== "signal.interests.entities.include") ||
          (k.startsWith("filter.") &&
            !["filter.type"].includes(k) &&
            !/\.radius$/.test(k))),
    );
    if (!meaningful) throw inputError();
    if (
      type === "urn:demographics" &&
      !q["signal.interests.entities"] &&
      !q["signal.interests.tags"]
    )
      throw inputError();
    if (
      type === "urn:heatmap" &&
      (!(q["filter.location"] || q["filter.location.query"]) ||
        !(q["signal.interests.entities"] || q["signal.interests.tags"]))
    )
      throw inputError();
    if (q["heatmap.dimensions"] && q["output.heatmap.boundary"] !== "geohash")
      throw inputError();
    for (const dimension of ["hotel_class", "price_level"])
      if (
        q[`filter.dimensions.${dimension}`] &&
        !(q["heatmap.dimensions"] as string[] | undefined)?.includes(dimension)
      )
        throw inputError();
  }
  return q;
}

/** Sort keys, preserve CSV order, distinguish omitted/false/zero; reject nested or ambiguous CSV. */
export function encodeQuery(query: Query): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (
      !values.length ||
      values.some(
        (v) =>
          !["string", "number", "boolean"].includes(typeof v) ||
          (typeof v === "number" && !Number.isFinite(v)) ||
          (typeof v === "string" &&
            (!v.trim() || (Array.isArray(value) && v.includes(",")))),
      )
    )
      throw inputError();
    params.set(key, values.map(String).join(","));
  }
  const encoded = params.toString();
  if (encoded.length > 16_384) throw inputError();
  return encoded;
}
