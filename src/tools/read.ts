import { randomUUID } from "node:crypto";
import { writeAuditRow } from "../audit/log.js";
import type { ChainAdapter } from "../chain/types.js";
import { acquireWalletLock, BusyError } from "../payments/lock.js";
import type { PaymentStore } from "../payments/store.js";
import { NetworkError } from "../chain/network.js";
import type { ReadErrorCode } from "../errors.js";
import type { Config, ReadAuditEntry, ReadTool } from "../types.js";

export interface ReadDeps {
  config: Config;
  chain: ChainAdapter;
}

export interface ReadResult<T> {
  ok: boolean;
  text: string;
  data?: T;
  audit: ReadAuditEntry;
  auditWarning?: string;
}

/** Thrown by a read tool for bad input. Audited as `rejected`, not `error`. */
export class ReadRejection extends Error {
  constructor(
    readonly code: ReadErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ReadRejection";
  }
}

/**
 * Run a wallet read without racing a send. It takes the wallet lock without waiting: while a
 * send holds it (from before the build until after the transmit) the read is refused with
 * BUSY, so nothing reads the wallet between stage and transmit.
 */
export async function withWalletRead<T>(store: PaymentStore, purpose: string, fn: () => Promise<T>): Promise<T> {
  let lock;
  try {
    lock = await acquireWalletLock(store, 0, purpose);
  } catch (e) {
    if (e instanceof BusyError) throw new ReadRejection("BUSY", "The wallet is busy with a send or sync. Try again shortly.");
    throw e;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Runs a read-only tool call and writes one audit row for it, success or failure,
 * the same way every zcash_pay call is audited. Reads move no funds, so a failed
 * audit write does not hide the answer; it is reported as `audit_warning`.
 */
export async function runReadTool<T>(
  tool: ReadTool,
  config: Config,
  fn: () => Promise<T>,
  toJson: (data: T) => Record<string, unknown>,
  extra: Pick<ReadAuditEntry, "limit" | "ref_call_id"> | (() => Pick<ReadAuditEntry, "limit" | "ref_call_id">) = {}
): Promise<ReadResult<T>> {
  let data: T | undefined;
  let status: ReadAuditEntry["status"] = "ok";
  let error: string | undefined;
  let code: ReadErrorCode | undefined;
  try {
    data = await fn();
  } catch (e) {
    if (e instanceof ReadRejection) {
      status = "rejected";
      code = e.code;
    } else {
      status = "error";
      code = e instanceof NetworkError && e.reason === "mainnet" ? "MAINNET_REFUSED" : "CHAIN_ERROR";
    }
    error = e instanceof Error ? e.message : String(e);
  }

  const audit: ReadAuditEntry = {
    ts: new Date().toISOString(),
    tool,
    call_id: randomUUID(),
    mode: config.chainMode,
    status,
    code,
    error,
    ...(typeof extra === "function" ? extra() : extra),
  };
  const auditWarning = writeAuditRow(config, audit).warning;

  if (status !== "ok" || data === undefined) {
    return {
      ok: false,
      text: JSON.stringify(
        { ok: false, status, code, message: error, error, audit_warning: auditWarning },
        null,
        2
      ),
      audit,
      auditWarning,
    };
  }
  return {
    ok: true,
    text: JSON.stringify(
      { ok: true, mode: config.chainMode, ...toJson(data), audit_warning: auditWarning },
      null,
      2
    ),
    data,
    audit,
    auditWarning,
  };
}
