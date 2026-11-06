/**
 * ZEC amounts as integer zatoshis (1 ZEC = 100,000,000 zatoshis).
 * Parsing works on the decimal digits only, never on float math, and never rounds.
 */
export const ZATS_PER_ZEC = 100_000_000n;
export const MAX_DECIMALS = 8;
/** Total ZEC supply. No valid amount or cap can be larger. */
export const MAX_MONEY_ZATS = 21_000_000n * ZATS_PER_ZEC;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/** Turn a JS number into its exact shortest decimal string, expanding exponent notation. */
function numberToDecimalString(n: number): string {
  const s = String(n);
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i);
  if (!m) return s;
  const [, sign, intPart, fracPart = "", expStr] = m;
  const exp = Number(expStr);
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Parse a ZEC amount given as a decimal string or a number into zatoshis.
 * Rejects non-finite, zero, negative, malformed, more-than-8-decimal, and above-supply amounts.
 */
/** Longest amount string accepted. "21000000.00000000" is 17 characters. */
export const MAX_AMOUNT_LENGTH = 32;

export function parseZecToZats(value: unknown, label = "Amount"): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AmountError(`${label} must be a finite number.`);
    }
    text = numberToDecimalString(value);
  } else if (typeof value === "string") {
    // Bound before any other work. Messages below never repeat the caller's text.
    if (value.length > MAX_AMOUNT_LENGTH) {
      throw new AmountError(`${label} is longer than ${MAX_AMOUNT_LENGTH} characters.`);
    }
    text = value.trim();
  } else {
    throw new AmountError(`${label} must be a decimal string or number, got ${typeof value}.`);
  }

  if (/^[+-]?(nan|infinity)$/i.test(text)) {
    throw new AmountError(`${label} must be a finite number.`);
  }
  if (text.startsWith("-")) {
    throw new AmountError(`${label} must be positive.`);
  }
  const m = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) {
    throw new AmountError(`${label} must be a plain decimal ZEC value like "0.05".`);
  }
  const [, intPart, fracPart = ""] = m;
  if (fracPart.length > MAX_DECIMALS) {
    throw new AmountError(
      `${label} has more than ${MAX_DECIMALS} decimal places; ZEC amounts must be whole zatoshis.`
    );
  }
  const zats = BigInt(intPart) * ZATS_PER_ZEC + BigInt(fracPart.padEnd(MAX_DECIMALS, "0"));
  if (zats <= 0n) {
    throw new AmountError(`${label} must be greater than zero.`);
  }
  if (zats > MAX_MONEY_ZATS) {
    throw new AmountError(`${label} is more than the 21,000,000 ZEC supply.`);
  }
  return zats;
}

/** Format zatoshis as a ZEC decimal string without trailing zeros, e.g. 5000000n -> "0.05". */
export function formatZats(zats: bigint): string {
  const sign = zats < 0n ? "-" : "";
  const abs = zats < 0n ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const frac = (abs % ZATS_PER_ZEC).toString().padStart(MAX_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
