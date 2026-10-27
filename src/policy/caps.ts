import { AmountError, formatZats, parseZecToZats } from "./amount.js";

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
    throw new PolicyError(e instanceof AmountError ? e.message : `Invalid amount: ${amountZec}.`);
  }
  try {
    capZats = parseZecToZats(capZec, "Spending cap");
  } catch (e) {
    throw new PolicyError(`Invalid spending cap: ${e instanceof Error ? e.message : capZec}`);
  }
  if (amountZats > capZats) {
    throw new PolicyError(
      `Amount ${formatZats(amountZats)} ZEC exceeds hard per-call spending cap of ${formatZats(capZats)} ZEC.`
    );
  }
  return amountZats;
}

export class PolicyError extends Error {
  readonly code = "POLICY_REJECTED" as const;
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}
