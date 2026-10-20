import "server-only";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { cookies } from "next/headers";
import { AppError } from "./errors";
import { hosted, verifyDeployment, trustProxyIp } from "./deployment";
import { isIP } from "node:net";
const shared = globalThis as typeof globalThis & { mixtapeSecret?: string };
const localSecret =
  shared.mixtapeSecret ??
  (shared.mixtapeSecret = randomBytes(32).toString("hex"));
export const opaque = () => randomBytes(24).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function secret() {
  const v = process.env.SESSION_SECRET;
  if (v && v.length >= 32) return v;
  if (hosted())
    throw new AppError(503, "Session storage is unavailable.");
  return localSecret;
}
export const sign = (value: string) =>
  createHmac("sha256", secret()).update(value).digest("base64url");
export function verifyCookie(value: string | undefined): string | null {
  if (!value) return null;
  const [id, expiry, sig] = value.split(".");
  if (!id || !expiry || !sig || Number(expiry) < Date.now()) return null;
  const expected = sign(`${id}.${expiry}`);
  return sig.length === expected.length &&
    timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ? id
    : null;
}
export async function session(create = false) {
  const jar = await cookies();
  let id = verifyCookie(jar.get("mixtape_session")?.value);
  if (!id && !create)
    throw new AppError(403, "This browser cannot edit that draft.");
  if (create) {
    id ??= opaque();
    const expiry = Date.now() + 30 * 86400000;
    const value = `${id}.${expiry}`;
    jar.set("mixtape_session", `${value}.${sign(value)}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 86400,
      path: "/",
    });
  }
  return id!;
}
export function checkOrigin(req: Request) {
  verifyDeployment();
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const expected =
    process.env.APP_ORIGIN ||
    `${url.protocol}//${req.headers.get("host") ?? url.host}`;
  if (origin !== expected || req.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(403, "This request is not allowed.");
}
export function ipKey(req: Request) {
  verifyDeployment();
  // Tiffin's XFF_DEPTH=1 contract: the final hop is supplied by the edge.
  // Never trust an earlier address supplied by the visitor.
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  if (hosted() && (!forwarded || !isIP(forwarded)))
    throw new AppError(503, "This public demo is not configured yet. Saved views remain readable.");
  const ip = trustProxyIp() ? (forwarded && isIP(forwarded) ? forwarded : "unknown") : "local";
  return hash(`${sign(new Date().toISOString().slice(0, 10))}:${ip}`);
}
export async function body(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError(400, "Use a JSON request.");
  if (Number(req.headers.get("content-length")) > 16384)
    throw new AppError(400, "This request is too large.");
  const reader = req.body?.getReader();
  if (!reader) throw new AppError(400, "A request body is required.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > 16384) throw new AppError(400, "This request is too large.");
      chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, "The request could not be read.");
  } finally {
    void reader.cancel().catch(() => {});
  }
}
