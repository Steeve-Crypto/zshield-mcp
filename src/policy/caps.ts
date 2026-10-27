import { AmountError, formatZats, parseZecToZats } from "./amount.js";
import type { PayRejectionCode } from "../errors.js";

/**
 * Hard per-call spending cap. Amount and cap are parsed to integer zatoshis and compared exactly.
 * Returns the amount in zatoshis.
 */
export function assertWithinCap(amountZec: number | string, capZec: number | string): bigint {
  let amountZats: bigint;
  let capZats: bigint;
  try {
    amountZats = parseZecToZats(amountZec, "Amount");
  } catch (e) {
    throw new PolicyError("INVALID_AMOUNT", e instanceof AmountError ? e.message : "Invalid amount.");
  }
  try {
    capZats = parseZecToZats(capZec, "Spending cap");
  } catch (e) {
    throw new PolicyError("INVALID_CAP", `Invalid spending cap: ${e instanceof Error ? e.message : capZec}`);
  }
  if (amountZats > capZats) {
    throw new PolicyError(
      "CAP_EXCEEDED",
      `Amount ${formatZats(amountZats)} ZEC exceeds hard per-call spending cap of ${formatZats(capZats)} ZEC.`
    );
  }
  return amountZats;
}

/** A policy refusal. Nothing is sent. `code` is stable; the message is for people. */
export class PolicyError extends Error {
  constructor(
    readonly code: PayRejectionCode,
    message: string
  ) {
    super(message);
    this.name = "PolicyError";
  }
}
