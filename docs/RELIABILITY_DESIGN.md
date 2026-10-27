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

Location: `<wallet dir>/.zshield-state`, where the wallet dir is resolved with `realpath`, so two spellings of the same folder find the same store. A chain with no wallet dir (mock mode, test adapters) gets a store beside the audit dir, at `<parent of AUDIT_DIR>/.zshield-state`. If that cannot be created, it falls back to a private folder in the temp dir named after this user and the audit dir. A wallet's store never moves.

The folder is mode `700` and every file in it `600`. Startup refuses a store, audit dir, or audit file that is a symlink or owned by another user, and tightens loose modes. On Windows the same folders go through the `icacls` check.

Layout:

- `keys/<sha256 of key>.json`: the binding of an idempotency key to one call id and the hash of its amount, recipient, and memo. Written to a temp file, fsynced, then hard linked into place. A link fails if the name exists, so exactly one call wins a key, even across processes and even if the lock has failed.
- `calls/<call id>/<event>.json`: the call's history as small immutable event files: the intent (amount, recipient, memo, the chain tip at the time), then results such as sent with a txid, not sent, unknown, mined, or proven expired. Each is written once and fsynced.
- `pending/<call id>`: a marker for a call whose outcome is not settled yet. Recovery lists only this folder.
- `txids/<txid>`: which call a txid belongs to, created exclusively, so recovery never credits one transaction to two calls.
- `wallet.lock`: the wallet lease (below).
- `meta.json`: store version.
- `imports/<hash of audit paths>`: one marker per audit dir whose log was imported. The first time a server opens the store with a given `AUDIT_DIR` and fallback file, it imports the payments in that log once, then writes the marker. So a second server with its own older log brings its keys along too, and nothing rebuilds from the log again. Old `not_found` results come in as `unknown`, since they came from a truncated history. An `ok` row with no txid comes in as `sent`. The import costs about 15 seconds per 20,000 rows, once.

A call's state is the join of its events, not the last one written. The order is `pending` < `unknown` < `not sent` = `expired` < `sent` < `mined`. Writers append events and never rewrite them, so two processes racing to settle a call cannot overwrite each other, and a stale `expired` can never hide a `mined`.

## The wallet lease

One lock file per store, created with `O_EXCL`. It holds the owner's pid, host, and a random token. While held, a heartbeat renews the file's mtime every few seconds. A lease is stale when its mtime is older than the lease time (60 seconds by default, `ZSHIELD_LOCK_LEASE_MS`, bounded) or its process is gone on this host. A slow send keeps renewing, so it is never broken into. A stalled or frozen holder stops renewing and loses the lease.

Fencing: the holder checks that the file still carries its token, and that its last renewal is recent, right before binding a key and right before broadcasting. A holder that lost the lease stops and sends nothing. If it stalls between that check and the send, the exclusive key binding still stops a second send for the same key.

## A send, step by step

1. Policy checks, then the viewing key fingerprint. No lock yet.
2. If the key is already bound, replay its call. Nothing is sent.
3. Take the in-process lock, then the wallet lease. Re-read the key, since another process may have bound it while this one waited.
4. Health check: bounded sync, chain tip, funds. It records the chain tip for the expiry proof. A failure here binds nothing, so the caller may retry with the same key.
5. Fence check, then write the intent event and the pending marker.
6. Write the audit `pending` row. If it cannot reach disk, record `not sent` and stop.
7. Fence check, then bind the key. Losing the key race means another call owns it: record `not sent` for this call and replay the winner.
8. Broadcast. Nothing runs between the bind and the start of `zingo-cli` but synchronous code.
9. Record the result event (`sent` with txid, `not sent` for a clear refusal, or `unknown`), claim the txid, write the audit result row, and clear the pending marker once settled.

Binding last means an unbound key proves the call never reached the send. A call that crashed before binding can be retried with the same key.

## Recovery and status

Recovery runs at startup and settles pending calls, one at a time, under the lease, each with a fresh read of the call's events. It reads the full wallet history once per run, never a fixed number of entries, and matches on recipient, amount, and memo within a time window, skipping txids claimed by other calls.

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
- Lease staleness is judged by the lock file's mtime. All processes on one wallet must share a clock: the same host, or a network share whose clock agrees with theirs.
- The store needs hard links (`link`) for exclusive creates. On a filesystem without them, such as FAT, the first exclusive write fails and nothing is sent.
- A call that crashed after its intent but before binding stays `unknown` in status until the expiry proof, even though the unbound key shows it never reached the send. Retrying with the same key is safe.
- The allow-list cache trusts the file's identity, size, mtime, and ctime. On a filesystem with coarse timestamps, an edit that keeps the size within the same tick is seen on the next change.
