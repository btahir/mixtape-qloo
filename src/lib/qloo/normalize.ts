import { z } from "zod";
import type { QlooEntity } from "./schemas";
import type { Kind } from "../domain";

export const normalizedId = (id: string) => /^[0-9a-f-]{36}$/i.test(id) ? id.toUpperCase() : id;
export function entityKind(raw: QlooEntity): Kind | null {
  const types = [...(raw.types ?? []), raw.subtype, raw.type].filter((t): t is string => !!t && t.startsWith("urn:entity:"));
  const unique = [...new Set(types)];
  if (unique.length !== 1) return null;
  const kind = unique[0].slice("urn:entity:".length);
  return kind === "movie" || kind === "book" || kind === "artist" ? kind : null;
}
export function httpsUrl(value: unknown, hosts?: string[]) {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && (!hosts || hosts.includes(url.hostname))) return url.href;
  } catch {}
}
export function description(raw: QlooEntity) {
  const direct = raw.short_description ?? raw.properties?.short_description;
  if (direct) return direct.slice(0, 1200);
  const localized = z.array(z.object({ language: z.string().optional(), languages: z.array(z.string()).optional(), value: z.string() })).safeParse(raw.short_descriptions ?? raw.properties?.short_descriptions);
  const english = localized.success ? localized.data.find((v) => v.language === "en" || v.languages?.includes("en"))?.value : undefined;
  return (english ?? raw.description ?? raw.properties?.description)?.slice(0, 1200);
}
export function destination(raw: QlooEntity) {
  const providers = [raw.external, raw.properties?.external];
  for (const data of providers) {
    if (!data || typeof data !== "object") continue;
    for (const provider of ["imdb", "goodreads", "spotify"] as const) {
      const item = (data as Record<string, unknown>)[provider];
      const parsed = z.object({ id: z.string() }).safeParse(Array.isArray(item) ? item[0] : item);
      if (!parsed.success) continue;
      const id = parsed.data.id;
      if (provider === "imdb" && /^tt\d+$/.test(id)) return `https://www.imdb.com/title/${id}/`;
      if (provider === "goodreads" && /^\d+$/.test(id)) return `https://www.goodreads.com/book/show/${id}`;
      if (provider === "spotify" && /^[a-zA-Z0-9]{22}$/.test(id) && entityKind(raw) === "artist") return `https://open.spotify.com/artist/${id}`;
    }
  }
}
export function contributions(raw: QlooEntity, signalIds: string[]) {
  const parsed = z.array(z.object({ entity_id: z.uuid(), score: z.number().min(0).max(1) })).max(5).safeParse(raw.query?.explainability?.["signal.interests.entities"]);
  if (!parsed.success) return;
  const allowed = new Set(signalIds.map(normalizedId)), seen = new Set<string>();
  const result = [];
  for (const item of parsed.data) {
    const entityId = normalizedId(item.entity_id);
    if (!allowed.has(entityId) || seen.has(entityId)) return;
    seen.add(entityId);
    result.push({ entityId, score: item.score });
  }
  return result;
}
export function invalidRequiredSignals(warnings: unknown, signals: string[]): string[] {
  if (!Array.isArray(warnings)) return [];
  const required = new Set(signals.map(normalizedId));
  return [...new Set(warnings.flatMap((w) => w && typeof w === "object" && w.type === "not_found" && Array.isArray(w["signal.interests.entities"])
    ? w["signal.interests.entities"].filter((id: unknown): id is string => typeof id === "string" && required.has(normalizedId(id))).map(normalizedId) : []))];
}
export function invalidRequiredSignal(warnings: unknown, signals: string[]) {
  return invalidRequiredSignals(warnings, signals).length > 0;
}

/** Editorial sample guard only. Explicit user-confirmed choices are never silently removed. */
export function demoContentAllowed(raw: QlooEntity) {
  if (/^lolita(?:\s|$|\()/i.test(raw.name)) return false;
  const ratings = JSON.stringify(raw.properties?.content_rating ?? raw.properties?.content_ratings ?? "");
  if (/NC-17|TV-MA|X-rated/i.test(ratings)) return false;
  return !(raw.tags ?? []).some((tag) => "name" in tag && /^(sexual violence|sexual abuse|graphic violence|pornography|explicit sexual content)$/i.test(String(tag.name)));
}
