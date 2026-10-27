import { appendAuditEntry } from "../audit/log.js";
import type { RateLimitAuditEntry } from "../types.js";

export const RATE_LIMIT_DEFAULT_PER_MIN = 60;
export const RATE_LIMIT_MAX_PER_MIN = 10_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export const RATE_LIMITED_MESSAGE = "Too many tool calls this minute. Wait and try again.";

/**
 * Per-process limit on tool calls, counted in fixed one-minute windows across all tools.
 * Refused calls write no audit row of their own. They are counted, and the count goes into
 * one summary row when the window rolls over or on the next call after it, so a flood of
 * refused calls adds at most one row per minute to the log.
 */
export class RateLimiter {
  private windowStart: number;
  private allowed = 0;
  private refused: Record<string, number> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly limitPerMin: number,
    private readonly auditDir: string,
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS
  ) {
    this.windowStart = this.now();
  }

  /** Counts one call. Returns false when the call is over the limit and must be refused. */
  take(tool: string): boolean {
    const now = this.now();
    if (now >= this.windowStart + this.windowMs) {
      this.flush();
      this.windowStart = now - ((now - this.windowStart) % this.windowMs);
      this.allowed = 0;
    }
    if (this.allowed < this.limitPerMin) {
      this.allowed++;
      return true;
    }
    this.refused[tool] = (this.refused[tool] ?? 0) + 1;
    if (!this.timer) {
      // Write the summary when the window ends even if no further call arrives.
      this.timer = setTimeout(() => this.flush(), Math.max(0, this.windowStart + this.windowMs - now));
      this.timer.unref?.();
    }
    return false;
  }

  /** Refused calls in the current window that are not yet in a summary row. */
  pendingRefused(): number {
    return Object.values(this.refused).reduce((a, b) => a + b, 0);
  }

  /** Writes the summary row for refused calls, if any. Never throws. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const total = this.pendingRefused();
    if (total === 0) return;
    const row: RateLimitAuditEntry = {
      ts: new Date(this.now()).toISOString(),
      tool: "rate_limit",
      status: "rejected",
      code: "RATE_LIMITED",
      window_start: new Date(this.windowStart).toISOString(),
      limit_per_min: this.limitPerMin,
      refused_calls: total,
      refused_by_tool: { ...this.refused },
    };
    this.refused = {};
    try {
      appendAuditEntry(this.auditDir, row);
    } catch {
      // A failed summary write must not break the next allowed call. The count is lost.
    }
  }
}

/** Reads RATE_LIMIT_PER_MIN style input. Throws on anything but a whole number in range. */
export function parseRateLimit(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > RATE_LIMIT_MAX_PER_MIN) {
    throw new Error(`RATE_LIMIT_PER_MIN must be a whole number from 1 to ${RATE_LIMIT_MAX_PER_MIN}.`);
  }
  return n;
}
