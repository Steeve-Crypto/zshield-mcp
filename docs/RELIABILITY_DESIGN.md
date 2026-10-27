# Reliability design

How zshield-mcp makes sure one payment request leads to at most one send, even with several server processes on one wallet, crashes, slow servers, and stalled processes. This is the model the code follows. Each rule below has a test.

## Invariants

1. **No idempotency key ever causes two sends.** A send for a key happens only after that key is durably bound to exactly one call in the payment store, and binding is an exclusive create that only one process can win.
2. **All processes sharing a wallet share one canonical payment store.** The store lives inside the wallet directory, at an absolute path resolved from the wallet path itself. Audit directories, fallback files, and working directories play no part in finding it.
3. **Recovery and status never downgrade a payment.** States only move forward. A payment seen as sent or mined stays sent or mined, whatever a later, slower, or stale reader concludes.
4. **"Not sent" needs proof.** A missing transaction in a short or partial history proves nothing. Without proof the state stays `unknown`, and no answer tells the caller to pay again.
5. **Lookups are bounded.** Finding a key or a call reads one small file or folder. Nothing rebuilds an index from the whole audit log, on a miss or otherwise.
6. **The audit log is the human trail, not the source of truth.** Every call still gets audit rows. Idempotency, status, and recovery read the store.

## The payment store

Location: `<wallet dir>/.zshield-state`, where the wallet dir is resolved with `realpath`, so two spellings of the same folder find the same store. In mock mode there is no wallet dir unless `ZINGO_DATA_DIR` is set; then the store sits in the audit dir, since each mock wallet belongs to one process anyway.

The folder is mode `700` and every file in it `600`. Startup refuses a store, audit dir, or audit file that is a symlink or owned by another user, and tightens loose modes. On Windows the same folders go through the `icacls` check.

Layout:

- `keys/<sha256 of key>.json`: the binding of an idempotency key to one call id and the hash of its amount, recipient, and memo. Written to a temp file, fsynced, then hard linked into place. A link fails if the name exists, so exactly one call wins a key, even across processes and even if the lock has failed.
- `calls/<call id>/<event>.json`: the call's history as small immutable event files: the intent (amount, recipient, memo, the chain tip at the time), then results such as sent with a txid, not sent, unknown, mined, or proven expired. Each is written once and fsynced.
- `pending/<call id>`: a marker for a call whose outcome is not settled yet. Recovery lists only this folder.
- `txids/<txid>`: which call a txid belongs to, created exclusively, so recovery never credits one transaction to two calls.
- `lock`: the wallet lease (below).
- `meta.json`: store version. When a store is first created, settled and unsettled payments from the audit log of the process that creates it are imported once. Old `not_found` results are imported as `unknown`, since they came from a truncated history.

A call's state is the join of its events, not the last one written. The order is `pending` < `unknown` < `not sent` = `expired` < `sent` < `mined`. Writers append events and never rewrite them, so two processes racing to settle a call cannot overwrite each other, and a stale `expired` can never hide a `mined`.

## The wallet lease

One lock file per store, created with `O_EXCL`. It holds the owner's pid, host, and a random token. While held, a heartbeat renews the file's mtime every few seconds. A lease is stale when its mtime is older than the lease time (60 seconds by default, `ZSHIELD_LOCK_LEASE_MS`, bounded) or its process is gone on this host. A slow send keeps renewing, so it is never broken into. A stalled or frozen holder stops renewing and loses the lease.

Fencing: the holder checks that the file still carries its token, and that its last renewal is recent, right before binding a key and right before broadcasting. A holder that lost the lease stops and sends nothing. If it stalls between that check and the send, the exclusive key binding still stops a second send for the same key.

## A send, step by step

1. Policy checks, then the viewing key fingerprint. No lock yet.
2. If the key is already bound, replay its call. Nothing is sent.
3. Take the in-process lock, then the wallet lease.
4. Health check: bounded sync, chain tip, funds. A failure here binds nothing, so the caller may retry with the same key.
5. Fence check, then write the intent event and the pending marker, then bind the key. Losing the key race means another call owns it: write `not sent` for this call and replay the winner.
6. Write the audit `pending` row. If it cannot reach disk, record `not sent` and stop.
7. Fence check, then broadcast.
8. Record the result event (`sent` with txid, `not sent` for a clear refusal, or `unknown`), claim the txid, write the audit result row, and clear the pending marker once settled.

## Recovery and status

Recovery runs at startup and settles pending calls, one at a time, each under the lease and each with a fresh read of the call's events. It reads the full wallet history, never a fixed number of entries, and matches on recipient, amount, and memo within a time window, skipping txids claimed by other calls.

- One unclaimed match: claim the txid and record mined or sent.
- No match: `expired` only with proof that the transaction can no longer be mined. In testnet mode that means the wallet is synced, the full history was read, and the wallet height is past the chain tip at intent time plus the 40 block expiry and a 10 block margin. Without that, `unknown`.
- Several matches: `unknown`, with the candidates listed.

`zcash_payment_status` reads the store fresh on each call, never a cached view. It may record the same forward moves under the lease. It only says to pay again, with a new key, for `expired`, which now means proven.

## Timeouts

Every timeout comes from a bounded setting. Values outside the range stop the server at startup. The lease heartbeat keeps a long but healthy operation alive, and a frozen one loses the lease after at most the lease time.

## Known limits

- The lease and fencing protect the wallet file from two writers in the common case. A holder frozen exactly between its last fence check and starting `zingo-cli` can still run one command alongside a new holder. That can disturb the wallet file but cannot repeat a keyed payment, because of the exclusive binding.
- Calls without an idempotency key have no duplicate protection beyond the lease. That is by design: without a key there is no way to tell a retry from a new payment.
- The expiry proof trusts the wallet's scan and the 40 block expiry that `zingo-cli` sets.
