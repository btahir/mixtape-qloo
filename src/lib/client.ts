import type { Run, RunEvent } from "./domain";
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public resetAt?: number,
  ) {
    super(message);
  }
}
export async function awaitWithSignal<T>(job: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return job;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([job, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
export async function api<T>(
  url: string,
  method = "POST",
  data: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const deadline = AbortSignal.timeout(12000);
  try {
  const r = await fetch(url, {
    method,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(data) }),
  });
  const value = await r.json().catch(() => {
    throw new RequestError("We could not load the saved version. Check latest version and try again.", r.status || 503);
  });
  if (!r.ok)
    throw new RequestError(
      value.error ?? "The request failed.",
      r.status,
      value.resetAt,
    );
  return value as T;
  } catch (error) {
    if (deadline.aborted) throw new RequestError("This is taking longer than it should. Your draft is safe.", 504);
    throw error;
  }
}
export type PublicRun = Pick<
  Run,
  | "id"
  | "mode"
  | "status"
  | "events"
  | "error"
  | "failure"
  | "resultVersion"
  | "partialSlots"
  | "attempts"
  | "model"
>;
export async function agentRequest(
  data: unknown,
  onRun: (run: PublicRun) => void,
  onEvent: (e: RunEvent) => void,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(45000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
  const r = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: combined,
  });
  if (!r.ok) {
    const v = await r.json().catch(() => { throw new RequestError("We could not read the response. Check latest version before trying again.", r.status); });
    throw new RequestError(v.error, r.status, v.resetAt);
  }
  if (r.headers.get("content-type")?.includes("application/json")) {
    const v = await r.json();
    onRun(v.run);
    return v.run as PublicRun;
  }
  const reader = r.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    last: PublicRun | undefined;
  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const item = JSON.parse(line.slice(6));
        if (item.type === "data-run") {
          last = item.data;
          onRun(item.data);
        }
        if (item.type === "data-event") onEvent(item.data);
        if (item.type === "error") throw new Error(item.errorText);
      }
    }
    if (chunk.done) break;
  }
  if (!last || ["accepted", "running"].includes(last.status))
    throw new Error("The connection was interrupted.");
  return last;
  } catch (e) {
    if (deadline.aborted && !signal?.aborted)
      throw new RequestError("This is taking longer than it should. Your draft is safe.", 504);
    if (e instanceof SyntaxError)
      throw new RequestError("The connection was interrupted.", 503);
    throw e;
  }
}
export const message = (e: unknown) =>
  e instanceof SyntaxError ? "We could not load the saved version. Check latest version and try again."
    : e instanceof TypeError ? "The connection was interrupted."
    : e instanceof Error ? e.message : "The request failed. Try again.";
