import "server-only";
import { z } from "zod";
import { update, store, type Store } from "./store";
import { hosted } from "./deployment";
import { sleep } from "../qloo/client";

/** Shared across search, ranking, warming and retries; four local starts/second; public allocation allows at most two. */
export async function paceQloo(signal: AbortSignal = AbortSignal.timeout(12000), storage: Store = store()) {
  while (true) {
    signal.throwIfAborted();
    let wait = 0;
    await update("qloo:next-start", z.object({ next: z.number() }), (old) => {
      const now = Date.now();
      wait = Math.max(0, (old?.next ?? 0) - now);
      return wait ? old! : { next: now + (hosted() ? 510 : 260) };
    }, 60000, storage);
    if (!wait) return;
    await sleep(wait, signal);
  }
}
