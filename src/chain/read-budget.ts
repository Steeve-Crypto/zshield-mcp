import { AsyncLocalStorage } from "node:async_hooks";

/** One deadline for the entire MCP read, including sequential wallet commands. */
export const WALLET_READ_BUDGET_MS = 10_000;
/** Includes CLI kill/save grace and lock handoff, even with SEND_QUEUE_WAIT_MS=0. */
export const LIVE_PAYMENT_READ_WAIT_MS = 20_000;
const deadlines = new AsyncLocalStorage<number>();
export function withReadBudget<T>(fn: () => T): T {
  return deadlines.run(Math.min(deadlines.getStore() ?? Infinity, Date.now() + WALLET_READ_BUDGET_MS), fn);
}
export function readCommandBudget(requested: number): number {
  const deadline = deadlines.getStore();
  if (deadline === undefined) return requested;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Wallet read deadline exceeded. Try again after the wallet has synced.");
  return Math.min(requested, remaining);
}
export function readQuitGrace(): number | undefined {
  return deadlines.getStore() === undefined ? undefined : 500;
}
