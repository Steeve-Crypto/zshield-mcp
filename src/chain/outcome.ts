/**
 * The CLI ran out of time or was killed. It may have done its work anyway.
 */
export class CliTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliTimeoutError";
  }
}

/**
 * A send was started but its result is not known: zingo-cli timed out, was killed, or
 * exited without an error and without a txid. The transaction may have been broadcast.
 * Callers must not retry without checking wallet history first.
 */
export class SendOutcomeUnknownError extends Error {
  /** The txid that was bound before the transmit step, when the send got that far. */
  readonly txid?: string;
  constructor(message: string, txid?: string) {
    super(message);
    this.txid = txid;
    this.name = "SendOutcomeUnknownError";
  }
}

/** The lightwalletd server did not answer the pre-send check in time. */
export class ChainUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainUnreachableError";
  }
}
