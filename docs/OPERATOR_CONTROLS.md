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
