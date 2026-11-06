import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { jsonParser, type Token } from "stream-json/parser.js";
import { none } from "stream-chain/core";
import type { CliRunner, RunOptions } from "./live.js";
import { CliTimeoutError } from "./outcome.js";
import {
  lockWaitWithin,
  READ_LOCK_WAIT_MS,
  wrapForWallet,
  wrapperRefusal,
  missingPerl,
  type Wrapped,
} from "./walletlock.js";

export interface HistorySelection {
  txids: readonly string[];
  format: "transactions" | "json";
}
const MAX_RECORD = 1024 * 1024;
const MAX_RESULT = 4 * MAX_RECORD;
const FIELDS = new Set(["txid", "status", "spend_status", "value", "recipient_address", "kind"]);

/** Stream the complete output, retaining only bounded evidence for selected identities.
 * JSON is tokenized as JSON: memo text can never inject a note or transaction record.
 * Every listing occurrence is inspected, including duplicates AFTER the matching entry.
 */
export class HistoryProjector {
  private readonly ids: Set<string>;
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  private block = "";
  private inBlock = false;
  private blockId: string | undefined;
  private matches: string[] = [];
  private count = 0;
  private size = 0;
  private started = false;
  private done = false;
  private failure?: Error;
  private parser?: ReturnType<typeof jsonParser>;
  private stack: {
    object?: Record<string, unknown>;
    array?: unknown[];
    key?: string;
    memos?: boolean;
    used?: number;
    oversized?: boolean;
  }[] = [];
  private text = "";
  private readingKey = false;
  private fieldOversized = false;

  constructor(private readonly selection: HistorySelection) {
    if (
      selection.txids.length === 0 ||
      selection.txids.length > 50 ||
      selection.txids.some((s) => !/^[0-9a-f]{64}$/.test(s))
    )
      throw new Error("Invalid history selection.");
    this.ids = new Set(selection.txids);
    if (selection.format === "json") {
      this.parser = jsonParser({
        packValues: false,
        packKeys: false,
        packNumbers: false,
        streamKeys: true,
        streamStrings: true,
        streamNumbers: true,
      });

    }
  }
  private keep(value: string): void {
    this.size += Buffer.byteLength(value);
    if (this.size > MAX_RESULT) throw new Error("Selected transaction evidence exceeds the bounded result size.");
    this.matches.push(value);
  }
  private scalar(value: unknown): void {
    const top = this.stack.at(-1);
    if (top) {
      top.used = Math.min(MAX_RECORD + 1, (top.used ?? 0) + Buffer.byteLength(JSON.stringify(value)));
      if (top.used > MAX_RECORD || this.fieldOversized) top.oversized = true;
    }
    if (top?.object && top.key && FIELDS.has(top.key)) top.object[top.key] = value;
    if (top?.array && top.memos) {
      if (top.array.length >= 1024) top.oversized = true;
      if (!top.oversized) top.array.push(value);
    }
  }
  private token(t: Token): void {
    if (this.done || this.failure) return;
    try {
      switch (t.name) {
        case "startObject":
          this.stack.push({ object: Object.create(null) });
          break;
        case "startArray":
          this.stack.push({ array: [], memos: this.stack.at(-1)?.key === "memos" });
          break;
        case "startKey":
          this.readingKey = true;
          this.text = "";
          this.fieldOversized = false;
          break;
        case "endKey":
          if (this.stack.at(-1)) this.stack.at(-1)!.key = this.fieldOversized ? undefined : this.text;
          this.readingKey = false;
          this.text = "";
          break;
        case "keyValue":
          if (this.stack.at(-1)) this.stack.at(-1)!.key = t.value;
          break;
        case "startString":
        case "startNumber":
          this.fieldOversized = false;
          this.text = "";
          break;
        case "stringChunk":
        case "numberChunk": {
          const max = this.readingKey ? 256 : 65536;
          this.text += t.value;
          if (this.text.length > max) {
            this.fieldOversized = true;
            this.text = this.text.slice(0, max);
          }
          break;
        }
        case "endString":
          this.scalar(this.text);
          this.text = "";
          break;
        case "endNumber":
          this.scalar(Number(this.text));
          this.text = "";
          break;
        case "numberValue":
          this.scalar(Number(t.value));
          break;
        case "nullValue":
          this.scalar(null);
          break;
        case "trueValue":
          this.scalar(true);
          break;
        case "falseValue":
          this.scalar(false);
          break;
        case "endArray": {
          const top = this.stack.pop();
          const parent = this.stack.at(-1);
          if (top?.memos && parent?.object) {
            parent.used = (parent.used ?? 0) + (top.used ?? 0);
            if (parent.used > MAX_RECORD || top.oversized) parent.oversized = true;
            if (!parent.oversized) parent.object.memos = top.array;
          }
          if (this.stack.length === 0) this.done = true;
          break;
        }
        case "endObject": {
          const frame = this.stack.pop();
          const object = frame?.object;
          if (
            object &&
            ((typeof object.txid === "string" && this.ids.has(object.txid.toLowerCase())) ||
              (typeof object.spend_status === "string" &&
                [...this.ids].some(
                  (id) =>
                    object.spend_status === `confirmed spent in ${id}` ||
                    object.spend_status === `mempool spent in ${id}` ||
                    object.spend_status === `transmitted spent in ${id}` ||
                    object.spend_status === `calculated spent in ${id}`,
                )))
          ) {
            if (frame?.oversized) throw new Error("Selected transaction record exceeds the bounded size.");
            this.keep(JSON.stringify(object));
          }
          if (this.stack.length === 0) this.done = true;
          break;
        }
      }
      if (this.stack.length > 32) throw new Error("Wallet JSON nesting exceeds the bounded depth.");
    } catch (e) {
      this.failure = e instanceof Error ? e : new Error(String(e));
    }
  }
  feed(data: Buffer | string): void {
    let text = typeof data === "string" ? data : this.decoder.write(data);
    if (this.selection.format === "json") {
      if (!this.started) {
        this.line += text;
        const match = /(?:^|\n)[{[]/.exec(this.line);
        if (!match) {
          this.line = this.line.slice(-65536);
          return;
        }
        text = this.line.slice(match.index + (match[0].startsWith("\n") ? 1 : 0));
        this.line = "";
        this.started = true;
      }
      if (!this.done && !this.failure) {
        const batch = this.parser!(text);
        if (typeof batch === "object") for (const token of batch.values) this.token(token);
      }
      if (this.failure) throw this.failure;
      return;
    }
    this.line += text;
    let end: number;
    while ((end = this.line.indexOf("\n")) >= 0) {
      const line = this.line.slice(0, end).replace(/\r$/, "");
      this.line = this.line.slice(end + 1);
      this.listingLine(line);
    }
    if (this.line.length > MAX_RECORD) throw new Error("A wallet listing line exceeds the bounded record size.");
  }
  private listingLine(line: string): void {
    if (line === "{" && !this.inBlock) {
      this.inBlock = true;
      this.block = "{\n";
      this.blockId = undefined;
      return;
    }
    if (!this.inBlock) return;
    if (this.blockId === undefined) {
      const id = /^ {4}txid:[ \t]*([0-9a-f]{64})[ \t]*$/i.exec(line)?.[1].toLowerCase();
      if (id) {
        this.blockId = id;
        if (!this.ids.has(id)) this.block = "";
      }
    }
    if (this.block || (this.blockId && this.ids.has(this.blockId))) {
      this.block += `${line}\n`;
      if (this.block.length > MAX_RECORD) throw new Error("Selected wallet listing record exceeds the bounded size.");
    }
    if (line === "}") {
      if (this.blockId && this.ids.has(this.blockId) && this.count++ < 2 * this.ids.size) this.keep(this.block);
      this.block = "";
      this.blockId = undefined;
      this.inBlock = false;
    }
  }

  finish(): string {
    this.feed(this.decoder.end());
    if (this.selection.format === "json") {
      if (!this.done && !this.failure) {
        try {
          const batch = (this.parser as unknown as (chunk: typeof none) => unknown)(none) as ReturnType<NonNullable<typeof this.parser>>;
          if (typeof batch === "object") for (const token of batch.values) this.token(token);
        } catch { throw new Error("Incomplete wallet JSON; no complete evidence was obtained."); }
      }
      if (this.failure) throw this.failure;
      if (!this.done) throw new Error("Incomplete wallet JSON; absence cannot be inferred.");
      return `{\n"value_transfers":[${this.matches.join(",")}]\n}`;
    }
    if (this.line) this.listingLine(this.line);
    if (this.inBlock) throw new Error("Incomplete wallet listing; absence cannot be inferred.");
    return this.matches.join("\n");
  }
}

export function projectHistory(out: string, selection: HistorySelection): string {
  const p = new HistoryProjector(selection);
  p.feed(out);
  return p.finish();
}

/** A bounded-memory process reader. A parse failure never releases the wallet while
 * its child is alive: stop it, await close, then reject with no partial evidence. */
export const streamingHistoryRunner: CliRunner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeout = opts.timeoutMs ?? 120000;
    const projector = new HistoryProjector(opts.historySelect!);
    let wrapped: Wrapped | undefined;
    try {
      if (opts.lockFile)
        wrapped = wrapForWallet(bin, args, {
          lockFile: opts.lockFile,
          waitMs: lockWaitWithin(opts.lockWaitMs ?? READ_LOCK_WAIT_MS, timeout),
        });
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(wrapped?.bin ?? bin, wrapped?.args ?? args, { stdio: ["pipe", "pipe", "pipe"] });
    let failure: Error | undefined,
      stderr = "",
      timedOut = false;
    const soft = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    const hard = setTimeout(() => child.kill("SIGKILL"), timeout + (opts.killGraceMs ?? 5000));
    child.stdout.on("data", (data: Buffer) => {
      if (failure) return;
      try {
        projector.feed(data);
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(0, 65536);
    });
    child.on("error", (e) => {
      failure = e;
    });
    child.on("close", (code, signal) => {
      clearTimeout(soft);
      clearTimeout(hard);
      const refusal =
        wrapped &&
        (wrapperRefusal(wrapped.nonce, stderr) ?? (failure && missingPerl(failure as NodeJS.ErrnoException)));
      if (refusal) {
        reject(refusal);
        return;
      }
      if (timedOut) {
        reject(new CliTimeoutError("Wallet history lookup timed out; no complete evidence was obtained."));
        return;
      }
      if (failure || code !== 0 || signal) {
        reject(failure ?? new Error("Wallet history process failed; no complete evidence was obtained."));
        return;
      }
      try {
        resolve(projector.finish());
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input);
  });
