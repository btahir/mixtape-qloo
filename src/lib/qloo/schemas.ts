import { z } from "zod";

/** Documentation-derived wire contracts. Unknown metadata is retained, not invented. */
export const SCHEMA_VERSION = "qloo-wire-2";
const record = z.record(z.string(), z.unknown());
const finite = z.number(); // Zod 4 rejects NaN and infinities.
const score = finite.min(0).max(1);
const text = z.string().min(1);
export const entityIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
export const tagIdSchema = z
  .string()
  .max(512)
  .regex(/^urn:tag:[^\s,]+$/);
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Expected a real calendar date");

export const entityKinds = [
  "artist",
  "book",
  "brand",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "videogame",
] as const;
export type EntityKind = (typeof entityKinds)[number];
export type EntityType = `urn:entity:${EntityKind}`;
export type CompatibilityEntityType =
  "urn:entity:destination" | "urn:entity:locality" | "urn:entity:video_game";
export type InsightsType =
  | EntityType
  | CompatibilityEntityType
  | "urn:tag"
  | "urn:demographics"
  | "urn:heatmap";
export type SearchType =
  | EntityType
  | `urn:entity:${"actor" | "album" | "author" | "director" | "locality"}`;
export const entityTypeSchema = z.enum(
  entityKinds.map((kind) => `urn:entity:${kind}` as EntityType),
);

export const queryMetadataSchema = z
  .object({
    affinity: score.nullish(),
    affinity_rank: score.nullish(),
    popularity: score.nullish(),
    explainability: record.nullish(),
  })
  .passthrough();

export const tagSchema = z
  .object({
    id: tagIdSchema.optional(),
    tag_id: tagIdSchema.optional(),
    tag_value: z.string().nullish(),
    name: text,
    type: z.string().nullish(),
    subtype: z.string().nullish(),
    types: z.array(z.string()).nullish(),
    parents: z.array(z.unknown()).nullish(),
    query: queryMetadataSchema.nullish(),
    affinity: score.nullish(),
    popularity: score.nullish(),
  })
  .passthrough()
  .refine((tag) => !!(tag.id ?? tag.tag_id), "Tag identity is required");

const locationSchema = z
  .object({
    latitude: finite.min(-90).max(90).optional(),
    longitude: finite.min(-180).max(180).optional(),
    lat: finite.min(-90).max(90).optional(),
    lng: finite.min(-180).max(180).optional(),
    geohash: z.string().optional(),
  })
  .passthrough();

const entityFields = {
  description: z.string().nullish(),
  short_description: z.string().nullish(),
  disambiguation: z.string().nullish(),
  url: z.string().nullish(),
  release_year: finite.int().nullish(),
  publication_year: finite.int().nullish(),
  finale_year: finite.int().nullish(),
  latest_known_year: finite.int().nullish(),
  release_date: z.string().nullish(),
  publication_date: z.string().nullish(),
  title: z.string().nullish(),
  author: z.string().nullish(),
  page_count: finite.int().nonnegative().nullish(),
  episode_count: z.union([z.string(), finite.int()]).nullish(),
  platforms: z.union([z.string(), z.array(z.string())]).nullish(),
  price_level: finite.nullish(),
  business_rating: finite.nullish(),
  is_closed: z.boolean().nullish(),
  image: z.object({ url: z.string().nullish() }).passthrough().nullish(),
};

/** All entity categories share identity; category metadata may be flat or nested. */
export const entitySchema = z
  .object({
    entity_id: entityIdSchema.optional(),
    id: entityIdSchema.optional(),
    name: text,
    type: z.string().nullish(),
    subtype: z.string().nullish(),
    types: z.array(z.string()).nullish(),
    ...entityFields,
    properties: z.object(entityFields).passthrough().nullish(),
    location: locationSchema.nullish(),
    tags: z.array(z.union([tagSchema, z.strictObject({ type: tagIdSchema })])).nullish(),
    query: queryMetadataSchema.nullish(),
    affinity: score.nullish(),
    popularity: score.nullish(),
  })
  .passthrough()
  .refine(
    (entity) => !!(entity.entity_id ?? entity.id),
    "Entity identity is required",
  );
export type QlooEntity = z.infer<typeof entitySchema>;
export type QlooTag = z.infer<typeof tagSchema>;

const envelope = {
  success: z.literal(true).optional(),
  duration: finite.nonnegative().optional(),
  query: record.nullish(),
  warnings: z.unknown().optional(),
};
export const searchResponseSchema = z
  .object({ ...envelope, results: z.array(entitySchema) })
  .passthrough();
export const entitiesResponseSchema = searchResponseSchema;
export const entityInsightsResponseSchema = z
  .object({
    ...envelope,
    results: z
      .object({ entities: z.array(entitySchema), duration: finite.optional() })
      .passthrough(),
  })
  .passthrough();
export const tagsResponseSchema = z
  .object({
    ...envelope,
    results: z
      .object({ tags: z.array(tagSchema), duration: finite.optional() })
      .passthrough(),
  })
  .passthrough();
export const tagInsightsResponseSchema = tagsResponseSchema;

export const demographicSchema = z
  .object({
    // Demographics may reference a tag URN rather than an entity UUID.
    entity_id: z.union([entityIdSchema, tagIdSchema]),
    query: z
      .object({
        age: z.record(z.string(), finite).optional(),
        gender: z.record(z.string(), finite).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const demographicsResponseSchema = z
  .object({
    ...envelope,
    results: z
      .object({
        demographics: z.array(demographicSchema),
        duration: finite.optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const heatmapPointSchema = z
  .object({
    location: locationSchema.refine(
      (l) => l.latitude !== undefined && l.longitude !== undefined,
      "Heatmap coordinates required",
    ),
    query: queryMetadataSchema,
  })
  .passthrough();
export const heatmapResponseSchema = z
  .object({
    ...envelope,
    results: z
      .object({
        heatmap: z.array(heatmapPointSchema),
        duration: finite.optional(),
      })
      .passthrough(),
  })
  .passthrough();
export const trendPointSchema = z
  .object({
    date: calendarDateSchema,
    population_percentile: finite.min(0).max(100).nullish(),
    population_rank: finite.int().nullish(),
    population_rank_velocity: finite.int().nullish(),
    velocity_fold_change: finite.nullish(),
    population_percent_delta: finite.nullish(),
  })
  .passthrough();
export const trendingResponseSchema = z
  .object({
    ...envelope,
    results: z
      .object({
        trending: z.array(trendPointSchema),
        duration: finite.optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** [U] The docs define an array but leave comparison metrics unresolved. */
export const compareResponseSchema = z
  .object({ ...envelope, results: z.union([z.array(z.unknown()), z.object({
    tags: z.array(tagSchema), a: z.array(tagSchema), b: z.array(tagSchema), matchEntities: z.array(z.unknown()),
  }).passthrough()]) })
  .passthrough();
/** [U] No response schema in current docs. Validate envelope/presence only. */
export const tagTypesResponseSchema = z
  .object({ ...envelope, results: z.unknown() })
  .passthrough()
  .refine(
    (value) => Object.hasOwn(value, "results") && value.results !== undefined,
    "results required",
  );

export const errorResponseSchema = z
  .object({
    success: z.literal(false).optional(),
    code: z.union([finite, z.string()]).optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const responseSchemas = {
  search: searchResponseSchema,
  entities: entitiesResponseSchema,
  entityInsights: entityInsightsResponseSchema,
  tagInsights: tagInsightsResponseSchema,
  demographics: demographicsResponseSchema,
  heatmap: heatmapResponseSchema,
  tags: tagsResponseSchema,
  tagTypes: tagTypesResponseSchema,
  compare: compareResponseSchema,
  trending: trendingResponseSchema,
} as const;
export type ResponseName = keyof typeof responseSchemas;
export type ResponseFor<N extends ResponseName> = z.infer<
  (typeof responseSchemas)[N]
>;
export type InsightsResponse<T extends InsightsType> = T extends "urn:tag"
  ? ResponseFor<"tagInsights">
  : T extends "urn:demographics"
    ? ResponseFor<"demographics">
    : T extends "urn:heatmap"
      ? ResponseFor<"heatmap">
      : ResponseFor<"entityInsights">;
export function insightsResponseName(
  type: InsightsType,
): "entityInsights" | "tagInsights" | "demographics" | "heatmap" {
  return type === "urn:tag"
    ? "tagInsights"
    : type === "urn:demographics"
      ? "demographics"
      : type === "urn:heatmap"
        ? "heatmap"
        : "entityInsights";
}
