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

## Local operator commands

Use `npm run operator -- COMMAND` with the service deployment environment.
`pause` creates the durable stop marker immediately; in-flight transmission may
already have happened. `unpause --reviewed` removes it under the wallet lock.
`budget-init` conservatively accounts for existing intents and refuses to reset an
existing ledger. `approval-payload request.json` produces a one-hour approval
payload from the exact request and wallet fingerprint, under the wallet lock.

## Coordinated snapshot and quarantine restore

`npm run operator -- backup /private/backup/new-snapshot` pauses payments, holds
both the application lock and the backend CLI lock, then copies the complete wallet
(including payment/key/txid/approval/budget state), allow-list, approval envelopes,
audit sinks and capacity ledgers, and deployment settings. The destination parent
must already be private. Standalone wallet processes must also use the backend lock;
stop any independently launched CLI before maintenance. Shared audit directories
across unrelated wallets are not a supported deployment layout.

Every file is hashed; changed sources, links, special files and lock loss abort
publication. Keep the returned manifest digest separately from the backup. The
snapshot contains wallet secrets and is NOT encrypted by this command: retain it
only on an access-controlled encrypted volume and use authenticated encryption
before off-host transfer. The private signing keys are never part of this snapshot.

`npm run operator -- restore SNAPSHOT --to NEW_DIRECTORY MANIFEST_SHA256` checks
all copied entries against the separately retained digest and restores only to a
new quarantine location. Payments remain paused. Never restore just the seed or
wallet file while omitting payment state. Repoint deployment paths to restored
`wallet`, `audit`, `fallback`, `allowlist` and `approvals`; retain the fingerprint
salt and trust configuration in `settings/config.json`. The adjacent `audit.budget`
and `fallback.budget` must accompany their sinks. The restored manifest describes
the original snapshot; the added pause marker is intentional.

Before activation, stop and disable the old instance and wallet, confirm only one
installation can spend, reconcile unresolved original transactions, verify budget
and approval controls, then use `unpause --reviewed`. Never run old and restored
wallet copies concurrently. A snapshot can be older than already accepted payments;
restoring it cannot by itself prove no payment occurred since it was captured.
