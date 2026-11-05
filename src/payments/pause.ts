import { join } from "node:path";
import { readPrivate } from "../fsafe.js";
import { PolicyError } from "../policy/caps.js";
import type { PaymentStore } from "./store.js";

/** Operator-owned marker. No MCP tool can clear it. Never cache its absence. */
export function assertPaymentsEnabled(store: PaymentStore): void {
  try {
    if (readPrivate(join(store.dir, "payments.pause"), 4096) === undefined) return;
  } catch {
    // Unreadable, oversized or unsafe markers also stop transmission.
  }
  throw new PolicyError("PAYMENTS_PAUSED", "Payments are disabled by the operator. Status and reconciliation remain available.");
}
