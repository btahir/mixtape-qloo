import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "./errors";

export type ReleaseBudget = { qloo: number; modelMicroUsd: number; deadline: number };
const budgets = new AsyncLocalStorage<ReleaseBudget>();
export const withReleaseBudget = <T>(budget: ReleaseBudget, job: () => Promise<T>) => budgets.run(budget, job);
function active() {
  const budget = budgets.getStore();
  if (budget && Date.now() >= budget.deadline) throw new AppError(503, "Release warming deadline reached.");
  return budget;
}
export function chargeReleaseQloo() {
  const budget = active();
  if (!budget) return;
  if (budget.qloo >= 30) throw new AppError(503, "Release Qloo budget reached.");
  budget.qloo++;
}
/** Before every provider dispatch, including failed/unknown usage. No refunds.
 * Haiku <=8k input at the 5-minute cache-write price + <=1024 output tokens.
 * https://platform.claude.com/docs/en/about-claude/pricing
 * Integer microdollars avoid rounding admission past the $0.10 ceiling. */
export function chargeReleaseModel(model: string, inputBound: number, outputBound = 1024) {
  const budget = active();
  if (!budget) return;
  if (model !== "claude-haiku-5-5" || inputBound > 8000 || outputBound > 1024 || inputBound < 0 || outputBound < 0 || !Number.isFinite(inputBound + outputBound))
    throw new AppError(503, "Release warming requires the bounded Haiku policy.");
  const cost = Math.ceil(inputBound * 0.125 + outputBound * 0.50);
  if (budget.modelMicroUsd + cost > 100000) throw new AppError(503, "Release model budget reached.");
  budget.modelMicroUsd += cost;
}
