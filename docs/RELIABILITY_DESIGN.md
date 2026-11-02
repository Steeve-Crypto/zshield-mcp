# Reliability design

How zshield-mcp makes sure one payment request leads to at most one send, even with several server processes on one wallet, crashes, slow servers, and stalled processes. This is the model the code follows. Each rule below has a test.

## Invariants

1. **No idempotency key ever causes two sends.** A send for a key happens only after that key is durably bound to exactly one call in the payment store, and binding is an exclusive create that only one process can win.
2. **All processes sharing a wallet share one canonical payment store.** The store lives inside the wallet directory, at an absolute path resolved from the wallet path itself. Audit directories, fallback files, and working directories play no part in finding it.
3. **Recovery and status never downgrade a payment.** States only move forward. A payment seen as sent or mined stays sent or mined, whatever a later, slower, or stale reader concludes. A sent call that the wallet later marks failed moves forward to failed, and only a sighting in a block moves it past that. The stored record is append-only, so a call seen mined stays `mined` there. `zcash_payment_status` still answers from the wallet's latest view: if a later read no longer shows the call mined (a reorg), it says `broadcast` or `unknown` with `reorged: true` and `last_mined_height`, and never sends again.
4. **"Not sent" needs proof.** A missing transaction in a short or partial history proves nothing. Without proof the state stays `unknown`, and no answer tells the caller to pay again.
5. **Lookups are bounded.** Finding a key or a call reads one small file or folder. Nothing rebuilds an index from the whole audit log, on a miss or otherwise.
6. **The audit log is the human trail, not the source of truth.** Every call still gets audit rows. Idempotency, status, and recovery read the store.

## The payment store

Location: `<wallet dir>/.zshield-state`, where the wallet dir is resolved with `realpath`, so two spellings of the same folder find the same store. A chain with no wallet dir (mock mode, test adapters) gets a store beside the audit dir, at `<parent of AUDIT_DIR>/.zshield-state`. If that cannot be created, it falls back to a private folder in the temp dir named after this user and the audit dir. A wallet's store never moves.

The folder is mode `700` and every file in it `600`. Startup refuses a store, audit dir, or audit file that is a symlink or owned by another user, and tightens loose modes. It also refuses a store, audit dir, wallet, or allow-list path with a directory above it that another user could swap (group or other writable without the sticky bit, or owned by another non-root user). Testnet mode does not start on Windows, and mock mode on Windows has no ACL protection.

Layout:

- `keys/<sha256 of key>.json`: the binding of an idempotency key to one call id and the hash of its amount, recipient, and memo. Written to a temp file, fsynced, then hard linked into place. A link fails if the name exists, so exactly one call wins a key, even across processes and even if the lock has failed.
- `calls/<call id>/<event>.json`: the call's history as small immutable event files: the intent (amount, recipient, memo, the chain tip at the time), then results such as sent with a txid, not sent, unknown, failed, mined, or proven expired. The intent keeps the wallet's own height and the expiry anchor (see below). Each is written once and fsynced.
- `pending/<call id>`: a marker for a call whose outcome is not settled yet. Recovery lists only this folder.
- `txids/<txid>`: which call a txid belongs to, created exclusively, so recovery never credits one transaction to two calls.
- `ops/<operation id>.json`: which call an operation id was made for (below).
- `send.flock`: the file the whole-send lock (below) is taken on. It is empty.
- `zingo.flock`: the file the OS wallet lock (below) is taken on. It is empty.
- `tip.json`: the highest chain tip seen for this wallet.
- `meta.json`: store version.
- `imports/`: not created any more. A store from an older version may still have it and the imported calls (`by: "import"`, `imported`); they are read as before and left alone. Nothing is imported again, and the audit log is never read back.

A call's state is the join of its events, not the last one written. The order is `pending` < `unknown` < `not sent` = `expired` < `sent` < `failed` < `mined`. Writers append events and never rewrite them, so two processes racing to settle a call cannot overwrite each other, and a stale `expired` can never hide a `mined`.

## The wallet lock

One OS lock per wallet, held by the paying process for the whole send, from before the build to after the transmit. It is released by the kernel when the process finishes or dies, however it dies. There is no lease, no heartbeat and no stale-lock breaking. A frozen holder keeps the lock until it wakes and finishes or is killed, and nobody else sends meanwhile.

How it is held: node has no `flock`, so the process starts a tiny `perl` holder (perl is needed anyway, see below). The holder opens `send.flock`, takes `flock(2)` on it, prints `LOCKED`, then reads its stdin until end of file. The write end of that pipe belongs to the server process, so when the server releases the lock or dies, the pipe closes, the holder exits, and the kernel drops the lock. A stopped (SIGSTOP) server stops its holder's pipe from closing, so the lock stays. A killed holder shows up as a lost lock: the server checks it before the viewing key read, before the build, between build and transmit, and right before each `zingo-cli` start, and stops without sending if it is gone. Releasing waits for the holder to exit. A per-process queue sits in front, so two calls in one process wait their turn.

Reads (`zcash_balance`, `zcash_receive_address`, `zcash_history`, and `zcash_payment_status` when it must read the wallet) take the same lock without waiting. While a send holds it they return `BUSY`, so no read runs between the build and the transmit. The reverse also holds: a payment waits up to `SEND_QUEUE_WAIT_MS` for a running read, then gets `BUSY`.

The lock is required in live mode. The mock chain falls back to the in-process queue where perl or `flock` is missing (Windows).

## The OS wallet lock

The whole-send lock stops a second payer. This second lock covers a `zingo-cli` that a killed server left running: its holder is gone, but the wallet process is not, and a new server must not start another beside it.

Every `zingo-cli` process this server starts (sync, reads, send, transmit) is started through a small `perl` wrapper. The wrapper takes an exclusive `flock(2)` on `zingo.flock` and then `exec`s `zingo-cli`. The lock sits on a file descriptor that `zingo-cli` inherits, so the wallet process itself holds it for as long as it lives. A parent that is frozen, killed, or late cannot release it early or start a second wallet process beside the first:

- A new holder's `zingo-cli` waits for a still-running old one.
- The wrapper reports "did not start" with a stderr line that carries a random nonce known only to this process and the wrapper, plus a reserved exit code (75 busy, 77 no lock, 78 exec). Only that line counts. Nothing `zingo-cli` prints can pass for it.
- A wallet held by another process is a `BUSY` refusal: not sent, nothing recorded as sent.

This needs `perl` and a POSIX platform. Without perl, or on Windows, live mode refuses every wallet command and sends nothing. On Windows, testnet mode also refuses to start. Tests: `tests/v12r6.test.ts` (three processes, a killed parent, the nonce), `tests/invariants/lock.test.ts` (the whole-send lock: frozen holders, killed holder, reads between stage and transmit) and `tests/race.test.ts` (four processes, different keys, one frozen holder).

## A send, step by step

1. Policy checks and a live send's required `idempotency_key`. No lock yet. The memo is checked once here, and this same string is what the policy sees, what the audit row and intent hold, and what is sent.
2. If the key is already bound, replay its call. Nothing is sent.
3. Take the in-process queue, then the OS wallet lock, which stays held to the end of the send. Re-read the key, since another process may have bound it while this one waited. Then read the viewing key fingerprint, under the lock, so no read runs between build and transmit.
4. Health check: bounded sync, chain tip, funds. The tip must not be below the wallet's own height, nor below the highest tip recorded for this wallet, by more than 10 blocks, or the send is refused. It records the expiry anchor: the highest of the server tip, the wallet height, and the recorded mark. A failure here binds nothing, so the caller may retry with the same key.
5. Check the lock is still held, then read the key once more (the health check can take minutes, and another process may have bound it), then write the intent event and the pending marker.
6. Write the audit `pending` row. If it cannot reach disk, record `not sent` and stop.

The operation id is made in step 5, when the payment is authorized: `op_` and 32 hex digits from a random source, never from the caller. It is stored in the intent, indexed in `ops/<id>.json`, written on every audit row for the payment, returned by `zcash_pay`, and accepted by `zcash_payment_status`. A refused payment gets none.
7. Fence check, then bind the key. Losing the key race means another call owns it: record `not sent` for this call and replay the winner.
8. Send in two stages. First `send '<json>'` and `calculate` build and sign the transaction. Nothing is broadcast, and the output must hold one fee and one txid. Then the txid is written to the call (`stageTxid`), which also claims it, and fsynced. Only then is `transmit <txid>` run (never a bare `transmit`, which would send every calculated transaction), and it counts only if its output names that txid. The last fence check runs synchronously right before each `zingo-cli` start. A send process that ignores a polite stop is killed outright after its timeout plus 5 seconds.
9. Record the result event (`sent` with txid, `not sent` for a clear refusal, or `unknown`), write the audit result row, and clear the pending marker once settled.

Binding last means an unbound key proves the call never reached the send. A call that crashed before binding can be retried with the same key.

Staging the txid before `transmit` means a timeout or crash during the broadcast leaves the call's own transaction id on record. Recovery then asks the wallet about that txid, never about "a transaction that looks like it". A call that crashed before staging never transmitted anything.

## Recovery and status

Recovery handles pending records under the wallet lock, never resends, and keeps
transaction identity separate from content similarity. Known staged/returned txids use
bounded-memory streaming projection over the CLI output; the complete output is read,
including duplicate occurrences after a match. JSON corroboration (`notes all`, `coins
all`, `messages`) is retained. Missing, malformed, duplicated, or inconsistent evidence
never confirms a payment. A status request caches its last identity lookup so reconcile
and confirmation counting do not repeat the same four process reads.

Live absence stays `unknown`, irrespective of the old 120-block delta, 60-block margin,
or two-hour floor. Those thresholds are diagnostics, not proof against arbitrary reorgs.
No new-key retry is suggested. Existing expired and failed records are re-indexed at
startup and remain in the live wallet interlock until positive evidence or a local
non-transmission proof resolves them. Historical events are not rewritten.

An adapter declaring `stagesBeforeBroadcast: true` cannot transmit before `req.stage`
has durably stored the signed txid. An intent created by that protocol without a staged
or returned txid therefore has a local `not_sent` proof, independent of chain history.
Adapters without that capability and older records without transaction identity keep
legacy content matching: recipient, amount, exact memo, time/height placement, ownership,
and rival-call checks. Candidate lists are bounded; truncated lists are not absence proofs.

Recovery retains its existing call-count, time, sync, and lock-wait budgets. Status reads
fresh state under the lock, syncs when supported, and never races stage/transmit. Mock
expiry remains a synthetic terminal result; it is not a live-chain finality policy.

## Failed sends and key reuse

A send that returned a txid is `sent`. If the wallet later lists that transaction as failed (rejected, or expired without being mined), `zcash_payment_status` records `failed` for the call and reports `PAYMENT_FAILED`. A repeat call with the same key then returns `ok: false` with `PAYMENT_FAILED` and the txid, and sends nothing. The same key is not reused for a retry after a failure. The wallet's word `failed` is its own judgment, a wrong one would double pay, and the caller can decide with the explorer in hand. A wallet failure observation does not authorize a new-key retry. Live signed failures remain interlocked and are rechecked; a later mined sighting can resolve them. Status never moves a mined call to failed, and a transaction later seen mined moves a failed call to mined. If the wallet no longer shows a mined call as mined, the answer follows the wallet (`broadcast` or `unknown`, `reorged: true`), while the record stays `mined`.

A replay of a `sent` call that nobody has checked with `zcash_payment_status` still returns the original success, since the txid was broadcast. Check status before treating it as final.

## Timeouts

Every timeout comes from a bounded setting. Values outside the range stop the server at startup. Each `zingo-cli` run gets a hard kill after its timeout plus 5 seconds, so a process that ignores the polite stop cannot hold the wallet. A history read runs its commands under one deadline of the read timeout. `zcash_history` is offline, allows one call per wallet at a time (`BUSY`), and holds the wallet lock only while it reads.

## Known limits

- The locks need `perl` and a POSIX platform, work on a local filesystem (not on every network share), and do not cover a `zingo-cli` the operator starts by hand on the same wallet.
- A stalled payer that is still alive keeps the lock, and every other payer gets `BUSY` until it finishes or dies. That is the choice: a live holder is never replaced by a timer, so a frozen process cannot wake up and send beside a new one.
- A long read (history, status) makes a payment wait up to `SEND_QUEUE_WAIT_MS`, then `BUSY`.
- A transaction that was built (`calculate`) but never transmitted can stay in the wallet's pending list and hold its notes until the wallet drops it. It is never broadcast by this server, so it cannot pay anyone.
- Live payments require an idempotency key. Only mock payments may go without one, and they move no money.
- No finite live expiry margin proves non-payment. Unresolved signed transactions remain interlocked and may require operator investigation when reliable evidence is unavailable.
- The tip mark (`tip.json` in the store) only rises. After a deliberate testnet reset, or a wallet moved to a different chain, sends are refused with `CHAIN_ERROR` until the file is removed by hand.
- `zingo-cli` prints its history as human text, and a third party's incoming memo is part of that text. Newlines in memos are refused on the way out, but an incoming memo with crafted lines could still fake a transaction block in the listing. The JSON corroboration above catches a fake block (no matching note, coin or message), but a memo-less send is vouched for only by txid, status and height. This is why a match needs time or height placement, equal memo, a claim check and JSON corroboration, and why unplaced or unverified matches stay `unknown`.
- A call from before the two-step flow, with no memo, never confirms from history. Its candidate is listed for a human to check.
- Calls with identical recipient, amount, and memo started close together stay `unknown` until checked by hand.
- The store needs hard links (`link`) for exclusive creates. On a filesystem without them, such as FAT, the first exclusive write fails and nothing is sent.
- A two-step intent that never staged a transaction is locally proven not transmitted. Unbound keys remain retryable; no chain-absence assumption is required.
- Audit rows are never imported. A store that never had a key imported from an audit log (a very old install) has no record of that key, so the same key can pay again. Keep using the store: its keys and calls stay.
- The wallet path is checked before each send, not during it. A directory swapped in the moments between that check and zingo-cli opening the path is not caught. A hostile local user with write access to the data directories is out of scope (see SECURITY_MODEL.md).
- The allow-list cache trusts the file's identity, size, mtime, and ctime. On a filesystem with coarse timestamps, an edit that keeps the size within the same tick is seen on the next change.

## Hardening pass (run 7)

- **Expiry.** The pinned zingolib expires a transaction 120 blocks after its target height. Not sent is proven only after the wallet passes anchor + 1 + 120 + 60.
- **Unresolved sends block the wallet.** In live mode, a call with a signed txid that is not settled (mined or locally proven not sent) refuses every new send with `UNRESOLVED_PAYMENT`. A transmit error or a wallet Failed status is `unknown`, never `not_sent`.
- **No bare transmit.** `transmit` always carries a validated 64 hex txid. A bare one would send every calculated transaction in the wallet.
- **Chain check.** When `info` names the chain and consensus branch, a testnet server must say `test` and `77190ad9`, or the send is refused.
- **Lock file.** The holder refuses a lock file that is not a regular file owned by this user, and never blocks on a FIFO.
- **Operation index.** A lookup by operation_id answers only when the call carries that very id.
