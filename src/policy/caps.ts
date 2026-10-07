/**
 * Hard per-call spending cap. Amounts must be finite, positive, and <= cap.
 */
export function assertWithinCap(amountZec: number, capZec: number): void {
  if (!Number.isFinite(amountZec) || amountZec <= 0) {
    throw new PolicyError(`Invalid amount: ${amountZec}. Must be a positive finite number.`);
  }
  if (!Number.isFinite(capZec) || capZec <= 0) {
    throw new PolicyError(`Invalid spending cap: ${capZec}.`);
  }
  if (amountZec > capZec) {
    throw new PolicyError(
      `Amount ${amountZec} ZEC exceeds hard per-call spending cap of ${capZec} ZEC.`
    );
  }
}

export class PolicyError extends Error {
  readonly code = "POLICY_REJECTED" as const;
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}
