import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "../types.js";

export function fingerprintViewKey(material: string, salt: string): string {
  return createHash("sha256").update(`${salt}|${material}`).digest("hex").slice(0, 16);
}

export function appendAuditEntry(auditDir: string, entry: AuditEntry): string {
  mkdirSync(auditDir, { recursive: true });
  const day = entry.ts.slice(0, 10);
  const file = join(auditDir, `${day}.jsonl`);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return file;
}
