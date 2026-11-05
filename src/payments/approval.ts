import { createHash, createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { createExclusive, readPrivate } from "../fsafe.js";
import { PolicyError } from "../policy/caps.js";
import type { Config } from "../types.js";
import type { PaymentStore } from "./store.js";

const payloadSchema = z.object({
  domain: z.literal("zshield-payment-approval-v1"), network: z.enum(["testnet", "mainnet"]),
  wallet_fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  idempotency_key: z.string().min(1).max(128),
  params_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const envelopeSchema = z.object({ payload: payloadSchema, signatures: z.array(z.string().max(128)).min(1).max(5) }).strict();
export type ApprovalPayload = z.infer<typeof payloadSchema>;

/** Fixed serialization and domain separation: private signing keys never enter the service. */
export function approvalBytes(payload: ApprovalPayload): Buffer {
  const p = payloadSchema.parse(payload);
  return Buffer.from(JSON.stringify([p.domain, p.network, p.wallet_fingerprint, p.idempotency_key, p.params_sha256, p.expires_at]));
}
export function approvalFilename(key: string): string { return createHash("sha256").update(key).digest("hex") + ".json"; }

export function approvalKeys(config: Config) {
  const keys = config.approvalPublicKeys;
  const threshold = config.approvalThreshold ?? 1;
  if (!keys || keys.length < 1 || keys.length > 5 || !Number.isInteger(threshold) || threshold < 1 || threshold > keys.length || !config.approvalDir) throw new Error("Invalid approval trust configuration");
  const parsed = keys.map(k => createPublicKey(k));
  if (parsed.some(k => k.asymmetricKeyType !== "ed25519")) throw new Error("Approvals require Ed25519 keys");
  const unique = new Set(parsed.map(k => k.export({ format: "der", type: "spki" }).toString("hex")));
  if (unique.size !== parsed.length) throw new Error("Approval authorities must be distinct");
  return { keys: parsed, threshold };
}

/** Caller holds wallet lock. A signed grant is exact-key, exact-parameters and wallet-bound. */
export function assertApproval(config: Config, store: PaymentStore, key: string, paramsHash: string, fingerprint: string | null): void {
  try {
    if (!config.approvalPublicKeys) {
      if (readPrivate(join(store.dir, "approval-required"), 128) !== undefined) throw new Error("Approval controls cannot be silently disabled");
      return;
    }
    const trust = approvalKeys(config);
    createExclusive(store.dir, "approval-required", "Signed payment approval required\n");
    const raw = readPrivate(join(config.approvalDir!, approvalFilename(key)), 16_384);
    if (raw === undefined) throw new Error("Approval missing");
    const grant = envelopeSchema.parse(JSON.parse(raw));
    if (grant.payload.network !== (config.chainNetwork ?? "testnet") || grant.payload.wallet_fingerprint !== fingerprint || grant.payload.idempotency_key !== key || grant.payload.params_sha256 !== paramsHash || grant.payload.expires_at <= Date.now()) throw new Error("Approval does not authorize this payment");
    const bytes = approvalBytes(grant.payload);
    const count = trust.keys.filter(publicKey => grant.signatures.some(signature => {
      if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
      return verify(null, bytes, publicKey, Buffer.from(signature, "base64"));
    })).length;
    if (count < trust.threshold) throw new Error("Insufficient distinct approvals");
  } catch {
    throw new PolicyError("APPROVAL_REQUIRED", "A valid operator-signed approval for this wallet, key and exact payment is required. No private approval key belongs on this service.");
  }
}
