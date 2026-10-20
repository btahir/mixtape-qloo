import entities from "./fixtures/entities.json" with { type: "json" };
import movie from "./fixtures/insights-movie.json" with { type: "json" };
import artist from "./fixtures/insights-artist.json" with { type: "json" };
import book from "./fixtures/insights-book.json" with { type: "json" };
import tv from "./fixtures/insights-tv_show.json" with { type: "json" };
import place from "./fixtures/insights-place.json" with { type: "json" };
import brand from "./fixtures/insights-brand.json" with { type: "json" };
import person from "./fixtures/insights-person.json" with { type: "json" };
import podcast from "./fixtures/insights-podcast.json" with { type: "json" };
import videogame from "./fixtures/insights-videogame.json" with { type: "json" };
import tags from "./fixtures/tags.json" with { type: "json" };
import demographics from "./fixtures/demographics.json" with { type: "json" };
import heatmap from "./fixtures/heatmap.json" with { type: "json" };
import compare from "./fixtures/compare.json" with { type: "json" };
import tagTypes from "./fixtures/tag-types.json" with { type: "json" };
import trending from "./fixtures/trending.json" with { type: "json" };
import { QLOO_ORIGIN, type QlooTransport } from "./client";
import { assertServer, cancelledError } from "./errors";

const catalog: Record<
  string,
  {
    results: { entities: { entity_id: string; [key: string]: unknown }[] };
    [key: string]: unknown;
  }
> = {
  movie,
  artist,
  book,
  tv_show: tv,
  place,
  brand,
  person,
  podcast,
  videogame,
};
const fixtureNotice = entities.fixture_notice;
const csv = (value: string | null): string[] =>
  value?.split(",").map((s) => s.toLowerCase()) ?? [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const reject = () =>
  json(
    {
      success: false,
      message: "Unsupported fixture request. See fixtures/README.md.",
      fixture: true,
    },
    400,
  );
const slicePage = <T>(items: T[], query: URLSearchParams): T[] => {
  const take = Number(query.get("take") ?? 20);
  const start = Number(
    query.get("offset") ?? (Number(query.get("page") ?? 1) - 1) * take,
  );
  return items.slice(start, start + take);
};
/** Explicit, deterministic offline transport. Never calls global fetch or falls back to live data. */
export class FixtureTransport implements QlooTransport {
  readonly mode = "fixture" as const;
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    assertServer();
    if (init?.signal?.aborted) throw cancelledError();
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.origin !== QLOO_ORIGIN || (init?.method && init.method !== "GET"))
      return reject();
    const q = url.searchParams;
    let body: unknown;
    if (url.pathname === "/search") {
      const allowed = ["query", "types", "take", "page"];
      if ([...q.keys()].some((k) => !allowed.includes(k))) return reject();
      const query = q.get("query")?.toLocaleLowerCase() ?? "";
      const types = csv(q.get("types"));
      body = {
        ...entities,
        results: slicePage(
          entities.results.filter(
            (e) =>
              e.name.toLocaleLowerCase().includes(query) &&
              (!types.length || types.includes(e.subtype)),
          ),
          q,
        ),
      };
    } else if (url.pathname === "/entities") {
      if ([...q.keys()].some((k) => k !== "entity_ids")) return reject();
      const ids = csv(q.get("entity_ids"));
      body = {
        ...entities,
        results: entities.results.filter((e) =>
          ids.includes(e.entity_id.toLowerCase()),
        ),
      };
    } else if (url.pathname === "/v2/tags") {
      const allowed = [
        "filter.query",
        "filter.results.tags",
        "take",
        "page",
        "feature.typo_tolerance",
        "feature.semantic_search",
      ];
      if ([...q.keys()].some((k) => !allowed.includes(k))) return reject();
      // Semantic/typo matching is proprietary: fixtures only support literal matching.
      if (
        q.get("feature.semantic_search") === "true" ||
        q.get("feature.typo_tolerance") === "true"
      )
        return reject();
      const shortlist = csv(q.get("filter.results.tags"));
      body = {
        ...tags,
        results: {
          tags: slicePage(
            tags.results.tags.filter(
              (t) =>
                t.name
                  .toLowerCase()
                  .includes(q.get("filter.query")?.toLowerCase() ?? "") &&
                (!shortlist.length ||
                  shortlist.includes(t.id ?? t.tag_id ?? "")),
            ),
            q,
          ),
        },
      };
    } else if (url.pathname === "/v2/tags/types") {
      if ([...q.keys()].some((k) => !["take", "page"].includes(k)))
        return reject();
      body = { ...tagTypes, results: slicePage(tagTypes.results, q) };
    } else if (url.pathname === "/v2/analysis/compare") {
      body = compare;
    } else if (url.pathname === "/v2/trending") {
      body = {
        ...trending,
        results: {
          trending: slicePage(
            trending.results.trending.filter(
              (p) =>
                p.date >= q.get("filter.start_date")! &&
                p.date <= q.get("filter.end_date")!,
            ),
            q,
          ),
        },
      };
    } else if (url.pathname === "/v2/insights") {
      const type = q.get("filter.type");
      if (type === "urn:tag")
        body = { ...tags, results: { tags: slicePage(tags.results.tags, q) } };
      else if (type === "urn:demographics") {
        const ids = csv(
          q.get("signal.interests.entities") ?? q.get("signal.interests.tags"),
        );
        body = {
          ...demographics,
          results: {
            demographics: ids.map((id) => ({
              ...demographics.results.demographics[0],
              entity_id: id,
            })),
          },
        };
      } else if (type === "urn:heatmap") {
        // A canned NYC map cannot truthfully simulate arbitrary WKT or regions.
        if (
          q.get("filter.location.query") !== "New York" ||
          q.has("heatmap.dimensions")
        )
          return reject();
        body = heatmap;
      } else {
        const allowed = [
          "filter.type",
          "signal.interests.entities",
          "signal.interests.tags",
          "signal.demographics.age",
          "signal.demographics.gender",
          "signal.demographics.audiences",
          "signal.location.query",
          "filter.results.entities",
          "filter.exclude.entities",
          "take",
          "page",
          "offset",
          "feature.explainability",
        ];
        if ([...q.keys()].some((k) => !allowed.includes(k))) return reject();
        const template = catalog[type?.replace("urn:entity:", "") ?? ""];
        if (!template) return reject();
        const shortlist = csv(q.get("filter.results.entities"));
        const exclude = csv(q.get("filter.exclude.entities"));
        body = {
          ...template,
          results: {
            entities: slicePage(
              template.results.entities.filter(
                (e) =>
                  (!shortlist.length || shortlist.includes(e.entity_id)) &&
                  !exclude.includes(e.entity_id),
              ),
              q,
            ),
          },
        };
      }
    } else return reject();
    return json({
      ...(body as object),
      fixture: true,
      fixture_notice: fixtureNotice,
    });
  };
}
