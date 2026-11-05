# Operator controls

These controls add spending restrictions. They do not enable mainnet or constitute
independent release approval. Operators must isolate the service account from the
model's general filesystem/command tools: a process with the service's UID can
change its policy and state. MCP payment tools cannot modify these controls.

## Emergency pause

Create `payments.pause` inside the wallet's payment-state directory. Any contents,
an unreadable marker or an unsafe path blocks new payments and resume transmissions.
The marker is rechecked immediately before transmit authorization. Already started
network transmission cannot be recalled. Read-only reconciliation and historical
replays continue. Only the operator should remove the marker after investigation.

## Cumulative allowance

Set `TOTAL_SPENDING_CAP_ZEC` to an absolute lifetime principal allowance. It is
additional to the per-payment cap and uses integer zatoshis. It is NOT a rolling
window and excludes backend transaction fees. An operator can raise the absolute
ceiling after review; no timer, restart, key change or configuration omission resets
reserved spending. Failed, interrupted and uncertain attempts are not refunded.

The shared wallet lock serializes accounting across processes. A fixed-size ledger
atomically records the new total plus a pending receipt; immutable per-call receipts
make recovery idempotent. A crash between these steps finishes the same receipt
before admitting another reservation. The ledger is never reconstructed as zero
from missing or malformed state. Financial audit capacity is reserved first.

An existing wallet with historical intents requires explicit initialization, which
conservatively charges every historical intent. Historical resumptions lacking a
receipt incur another conservative reservation. This can consume more allowance
than was actually paid; it cannot silently authorize more principal than the cap.
Retain the ledger and all receipts with the wallet and payment records. Do not delete
or edit accounting files to replenish allowance.

## Signed approvals

`APPROVAL_PUBLIC_KEYS_JSON` is a JSON array of 1–5 PEM Ed25519 public keys.
`APPROVAL_THRESHOLD` sets how many distinct keys must authorize each payment.
Use 2 for two-person approval. `APPROVAL_DIR` holds signed envelopes named by
SHA-256 of the idempotency key plus `.json`. The signing keys must stay on separate
operator-controlled systems; public keys are the only signing material on the server.

The payload binds a versioned domain, testnet, salted wallet fingerprint, exact
idempotency key, canonical payment-parameter hash and expiration in epoch
milliseconds. Each signature is base64 Ed25519 over the fixed JSON array produced
by `approvalBytes`. Duplicate keys or repeated signatures cannot satisfy a
multi-person threshold. Missing, invalid, expired or changed approvals fail closed.
Approvals are checked before intent creation and again before transmission, including
automatic recovery and explicit resume. A historical read-only replay needs no new
approval. Once enabled, removing the trust configuration cannot disable approval
requirements; its durable marker remains with the wallet.

After independently reviewing recipient, amount and memo against the proposed
parameter hash, sign with `node --import tsx scripts/sign-approval.ts --approve
payload.json private-key.pem` on the signing host. The command outputs one envelope.
For multiple approvers, combine their signature strings only when every payload
field is identical. Copy the envelope, never the private key, to `APPROVAL_DIR`.
