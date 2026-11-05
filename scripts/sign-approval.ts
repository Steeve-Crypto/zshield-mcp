// Run on a separate signing host, never on the payment service.
import { createPrivateKey, sign } from "node:crypto";
import { readPrivate } from "../src/fsafe.js";
import { approvalBytes, type ApprovalPayload } from "../src/payments/approval.js";

const [confirm, payloadPath, keyPath] = process.argv.slice(2);
if (confirm !== "--approve" || !payloadPath || !keyPath || process.argv.length !== 5) {
  console.error("Usage: node --import tsx scripts/sign-approval.ts --approve payload.json private-key.pem");
  process.exit(1);
}
try {
  const payload = JSON.parse(readPrivate(payloadPath, 8192) ?? "null") as ApprovalPayload;
  const bytes = approvalBytes(payload);
  if (payload.expires_at <= Date.now()) throw new Error("Expired payload");
  const key = createPrivateKey(readPrivate(keyPath, 16384) ?? "");
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid signing algorithm");
  console.log(JSON.stringify({ payload, signatures: [sign(null, bytes, key).toString("base64")] }, null, 2));
} catch {
  console.error("Approval signing failed. Verify the payload and private Ed25519 key locally.");
  process.exit(1);
}
