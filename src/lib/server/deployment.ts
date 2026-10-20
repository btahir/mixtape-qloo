import "server-only";
import { AppError } from "./errors";
export function hosted() {
  if (process.env.TIFFIN_PROJECT || process.env.TIFFIN_URL || process.env.PUBLIC_DEMO === "true") return true;
  if (!process.env.APP_ORIGIN) return false;
  try { return !["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.APP_ORIGIN).hostname); }
  catch { return true; }
}
export function verifyDeployment() {
  if (!hosted()) return;
  let validOrigin = false;
  try { const url = new URL(process.env.APP_ORIGIN ?? ""); validOrigin = url.protocol === "https:" && url.origin === process.env.APP_ORIGIN; } catch {}
  if (!validOrigin || !process.env.REDIS_URL ||
    (process.env.SESSION_SECRET?.length ?? 0) < 32 || process.env.INGRESS_VERIFIED !== "true" ||
    process.env.TRUST_PROXY_IP !== "true")
    throw new AppError(503, "This public demo is not configured yet. Saved views remain readable.");
}
