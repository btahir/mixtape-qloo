import { withStoreDeadline } from "./store";
import "server-only";
import { z } from "zod";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { body, checkOrigin, session, ipKey, opaque } from "./security";
import { AppError, gone } from "./errors";
import { counter, rate } from "./limits";
import {
  owned,
  ownedLinks,
  listDrafts,
  createDraft,
  patchSchema,
  saveDraft,
  deleteDraft,
  undoDraft,
  confirmEntity,
  searchRefSchema,
  createShare,
  shareInput,
  manageShare,
  openReceipt,
  receiptAction,
} from "./repository";
import { search, qlooFailure } from "./qloo";
import { kindSchema } from "../domain";
import { put } from "./store";
import { getComparison } from "./comparison";
import { comparisonCases } from "../samples";
import {
  startRun,
  agentInput,
  executeRun,
  ownedRun,
  publicRun,
  cancelRun,
} from "./runs";
const v = z
  .object({ expectedVersion: z.number().int().nonnegative() })
  .strict();
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers });
}
export async function dispatch(
  req: Request,
  path: string[],
): Promise<Response> {
  const duration = path[0] === "agent" ? 45000 : path[0] === "entities" ? 12000 : 10000;
  const deadline = Date.now() + duration;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(duration)]);
  return withStoreDeadline(signal, deadline, async () => {
  try {
    signal.throwIfAborted();
    const method = req.method,
      read = method === "GET";
    if (!read) checkOrigin(req);
    // Public discovery reads only saved editorial records, just like /compare.
    // It neither creates a session nor starts a model/tool operation.
    if (read && path.length === 1 && path[0] === "comparisons") {
      await rate("read", "", ipKey(req));
      for (const sample of comparisonCases)
        if (await getComparison(sample.id)) return json({ href: `/compare/${sample.id}` });
      return json({});
    }
    const owner = await session(!read),
      ip = ipKey(req);
    if (read) await rate(path[0] === "runs" ? "poll" : "read", owner, ip);
    if (!read && path[0] === "runs") await rate("cancel", owner, ip);
    const raw = read ? undefined : await body(req);
    if (
      !read &&
      path[0] !== "agent" &&
      path[0] !== "runs" &&
      path[0] !== "entities"
    )
      await rate("write", owner, ip);
    if (path.length === 1 && path[0] === "drafts") {
      if (method === "GET") return json({ drafts: await listDrafts(owner) });
      if (method === "POST") {
        const p = z
          .object({
            source: z.enum(["empty", "sample", "fixture", "return", "repeat"]),
            sampleId: z.string().optional(),
            shareRef: z.string().max(200).optional(),
          })
          .strict()
          .parse(raw);
        await rate("create", owner, ip);
        await counter("draft-create:global", 1000, 86400000);
        return json(await createDraft(owner, p.source, p.sampleId, p.shareRef));
      }
    }
    if (path[0] === "drafts" && path[1]) {
      const id = path[1];
      if (path.length === 2) {
        if (method === "GET") return json(await owned(id, owner));
        if (method === "PATCH")
          return json(await saveDraft(id, owner, patchSchema.parse(raw)));
        if (method === "DELETE")
          return json(
            await deleteDraft(id, owner, v.parse(raw).expectedVersion),
          );
      }
      if (method === "POST" && path[2] === "undo")
        return json(await undoDraft(id, owner, v.parse(raw).expectedVersion));
      if (method === "POST" && path[2] === "confirm-entity") {
        const p = z
          .object({
            expectedVersion: z.number().int(),
            resultRef: z.string().max(100),
            list: z.enum(["shelf", "tastes"]),
          })
          .strict()
          .parse(raw);
        return json(
          await confirmEntity(
            id,
            owner,
            p.expectedVersion,
            p.resultRef,
            p.list,
          ),
        );
      }
      if (method === "GET" && path.length === 3 && path[2] === "shares")
        return json({ links: await ownedLinks(id, owner) });
      if (method === "POST" && path[2] === "shares") {
        await rate("share", owner, ip);
        const { share, token } = await createShare(
          id,
          owner,
          shareInput.parse(raw),
        );
        return json({
          id: share.id,
          token,
          path: `/m/${token}`,
          expiresAt: share.expiresAt,
          mode: share.mode,
        });
      }
    }
    if (path.join("/") === "entities/search" && method === "POST") {
      const p = z
        .object({
          query: z.string().trim().min(2).max(120),
          kind: kindSchema,
          draftId: z.string().max(100),
        })
        .strict()
        .parse(raw);
      const d = await owned(p.draftId, owner);
      await rate("search", owner, ip);
      const results = await search(p.query, p.kind, d.mode, owner, signal);
      const projected = [];
      for (const entity of results) {
        const ref = opaque();
        await put(
          `search:${ref}`,
          searchRefSchema,
          { owner, entity, expiresAt: Date.now() + 600000 },
          600000,
        );
        projected.push({ entity, resultRef: ref });
      }
      return json({ mode: d.mode, results: projected });
    }
    if (path[0] === "agent" && path.length === 1 && method === "POST") {
      const p = agentInput.parse(raw);
      const admissionDeadline = deadline;
      const admissionSignal = AbortSignal.any([req.signal, AbortSignal.timeout(45000)]);
      const result = await withStoreDeadline(admissionSignal, admissionDeadline, () => startRun(p, owner, ip, admissionDeadline));
      if (result.replay)
        return json({ replay: true, run: publicRun(result.run) });
      // Only safe, server-authored data events enter the SDK stream. Reasoning and
      // raw model/tool parts are never merged (including the SDK's default reasoning).
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: "data-run", data: publicRun(result.run) });
          await executeRun(
            result.run,
            result.draft!,
            (event) => writer.write({ type: "data-event", data: event }),
            req.signal,
          );
          writer.write({
            type: "data-run",
            data: publicRun(await withStoreDeadline(AbortSignal.timeout(2000), Date.now() + 2000, () => ownedRun(result.run.id, owner))),
          });
        },
        onError: () => "The connection was interrupted.",
      });
      return createUIMessageStreamResponse({ stream, headers });
    }
    if (path[0] === "runs" && path[1]) {
      if (read && path.length === 2)
        return json(publicRun(await ownedRun(path[1], owner)));
      if (method === "POST" && path[2] === "cancel") {
        z.object({}).strict().parse(raw);
        return json(await cancelRun(path[1], owner));
      }
    }
    if (path[0] === "shares" && path[1]) {
      z.object({}).strict().parse(raw);
      if (method === "DELETE" && path.length === 2)
        return json(await manageShare(path[1], owner));
      if (method === "POST" && path[2] === "rotate")
        return json(await manageShare(path[1], owner, true));
    }
    if (
      path[0] === "receive" &&
      path[1] &&
      path[2] === "open" &&
      method === "POST"
    ) {
      z.object({}).strict().parse(raw);
      return json(await openReceipt(path[1], owner));
    }
    if (
      path[0] === "receipts" &&
      path[1] &&
      path[2] === "actions" &&
      method === "POST"
    ) {
      const p = z
        .object({
          action: z.enum(["save", "unsave", "known", "decline", "undo"]),
          slotId: kindSchema,
          savedEntityId: z.string().max(100).optional(),
          expectedVersion: z.number().int(),
        })
        .strict()
        .parse(raw);
      return json(await receiptAction(path[1], owner, p));
    }
    throw gone();
  } catch (e) {
    if (e instanceof z.ZodError)
      return json({ error: "Check the request fields and try again." }, 400);
    const error = e instanceof AppError ? e : qlooFailure(e);
    return Response.json(
      {
        error: error.message,
        ...(error.retryAfter
          ? {
              retryAfter: error.retryAfter,
              resetAt: Date.now() + error.retryAfter * 1000,
            }
          : {}),
      },
      {
        status: error.status,
        headers: {
          ...headers,
          ...(error.retryAfter
            ? { "Retry-After": String(error.retryAfter) }
            : {}),
        },
      },
    );
  }
  });
}
