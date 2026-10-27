import { readFileSync } from "node:fs";
import type { AllowlistFile, RecipientEntry } from "../types.js";
import { PolicyError } from "./caps.js";

export function loadAllowlist(path: string): RecipientEntry[] {
  let parsed: AllowlistFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as AllowlistFile;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new PolicyError(`Cannot read allow-list at ${path}: ${reason}`);
  }
  if (!parsed?.recipients || !Array.isArray(parsed.recipients)) {
    throw new PolicyError(`Allow-list at ${path} must contain a "recipients" array.`);
  }
  return parsed.recipients.filter((r) => typeof r?.address === "string" && r.address.length > 0);
}

export function assertRecipientAllowed(
  recipient: string,
  allowlist: RecipientEntry[]
): RecipientEntry {
  const hit = allowlist.find((r) => r.address === recipient);
  if (!hit) {
    // The recipient is not repeated here; it is already in the audit row's recipient field.
    throw new PolicyError("Recipient is not on the allow-list. Add it to the allow-list file and restart.");
  }
  return hit;
}

export function isRecipientAllowed(recipient: string, allowlist: RecipientEntry[]): boolean {
  return allowlist.some((r) => r.address === recipient);
}
