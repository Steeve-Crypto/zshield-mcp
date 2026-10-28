# Security model

This document describes what zshield-mcp protects, what it trusts, and where it falls short today. It covers the code as it is in this repository. If the code and this document disagree, the code wins and this document has a bug.

## Summary

zshield-mcp lets an AI agent ask for shielded ZEC payments without ever holding a key. The agent can only call MCP tools. The server checks every payment against a per-call cap, an allow-list, and the network, writes an audit row, and only then asks `zingo-cli` to send. Mainnet is refused at several layers. The live adapter runs on Zcash testnet only, and the default is a mock chain that moves nothing.

It is a policy gate for a single local operator. It is not a custody system, it does not authenticate anyone, and it does not limit total spending over time.

## Where keys live

- **Mock mode.** There are no keys. The mock wallet is an in-memory ledger that starts at 10 ZEC and resets when the server restarts.
- **Testnet mode.** The wallet seed and spending keys live in the `zingo-cli` wallet file, by default `.zshield-testnet/wallet/zingo-wallet.dat` under the home directory the OS reports (`os.homedir()`, not `$HOME`). `ZINGO_DATA_DIR` must be absolute; a relative path, or no home directory, stops the server at startup instead of picking a directory relative to wherever it was launched. `zingo-cli` creates and manages that file. zshield-mcp never reads or parses it directly, and never passes a seed, spending key, or viewing key to the agent or into the audit log.
- **The viewing key in memory.** In testnet mode the server runs `zingo-cli export_ufvk` once per process, in an offline session, and keeps the unified full viewing key (UFVK) in memory to compute the audit fingerprint. It is never logged, written to disk, or returned by a tool. Anyone who can read the server's memory can read it, which is the same exposure as the wallet file.
- **The agent and the model.** They hold no keys. They see only tool results: txids, amounts, balances, the wallet's receive address, and transaction summaries.
- **The fingerprint salt.** `VIEW_KEY_FINGERPRINT_SALT` comes from the environment or `config/default.yaml`. The default value is `dev-only-change-me`. It is never returned by any tool or by the policy resource.

Limits today:

- On Windows, POSIX modes mean nothing, so the startup check reads the ACL of the wallet directory, the wallet file, the payment store, and the audit dir with `icacls` instead and refuses to start if Everyone, Users, Authenticated Users, Guests, or a similar broad group has read access, by name or SID. `ZSHIELD_HARDEN_WINDOWS_ACL=1` removes inherited entries and grants only the current user, then checks again. If the ACL cannot be read the server refuses to start unless `ZSHIELD_ALLOW_UNCHECKED_WINDOWS_ACL=1` is set.
- zshield-mcp does not encrypt the wallet file. In testnet mode it refuses to start if the wallet directory gives any access to group or other users. It wants `700` on the directory, and the error prints the `chmod` that fixes it. It refuses rather than warns because a warning on stderr is easy to miss when an MCP client starts the server. A file inside a private directory with a mode looser than `600` only gets a warning: other users cannot reach it, and `zingo-cli` rewrites the wallet file with the current umask on every save, so a hard refusal would trip after any manual `zingo-cli` run. The server sets umask `077` in testnet mode so its own `zingo-cli` runs keep the file at `600`. Root and the server's own OS user can still read the file, and the check runs only at startup.
- The server process runs as the same OS user as the wallet. A bug or compromise in the server process, its npm dependencies, or `zingo-cli` can reach the keys. Nothing in this design isolates them.

## What the server can do

- Send ZEC from the configured wallet to an address on the allow-list, up to `SPENDING_CAP_ZEC` per call, on testnet only. In mock mode it only updates the mock ledger.
- Read the wallet's balance, current unified address, and recent transactions through `zcash_balance`, `zcash_receive_address`, and `zcash_history`, and the state of an earlier payment through `zcash_payment_status`.
- Read the allow-list file on every `zcash_pay` call and every read of `zshield://policy`.
- Append rows to JSONL files in `AUDIT_DIR`.
- Run `zingo-cli` as a child process with a fixed argument list. It uses `execFile`, so no shell parses the arguments. For a send, argv holds only the chain, server, and data directory. The recipient, amount, and memo go to `zingo-cli`'s prompt over stdin as one `quicksend` line in its JSON form, so they never show up in the process list.

## What the server cannot do

- Pay an address that is not an exact match for an allow-list entry.
- Pay more than the cap in one call. Amounts and the cap are compared as integer zatoshis, so there is no float rounding to slip past the cap.
- Pay on mainnet. See "Mainnet refusal" below.
- Change its own policy. No tool writes the allow-list, the cap, the mode, or the audit settings.
- Export the seed or a viewing key to the agent. No code path calls `zingo-cli recovery_info`. `export_ufvk` runs only to compute the audit fingerprint, and the key stays in memory.
- Run arbitrary `zingo-cli` commands on behalf of the agent. The server uses a fixed set of commands: `quicksend`, `balance`, `spendable_balance`, `addresses`, `transactions`, `export_ufvk`, and for the pre-send check `info` and `height`.
- Send twice for one `idempotency_key`, or send anything during startup recovery or `zcash_payment_status`.

## Mainnet refusal

Mainnet is blocked at each of these layers:

1. `CHAIN_MODE` must be `mock`, `live`, or `testnet`. Anything else, including `mainnet`, stops the server at startup.
2. `CHAIN_MODE=live` alone also stops the server at startup. Only `testnet` turns on the live adapter.
3. The live adapter refuses to construct unless its network is exactly `testnet`.
4. Every `zingo-cli` call passes `--chain testnet`.
5. In testnet mode `zcash_pay` refuses mainnet addresses (`u1`, `zs1`, `t1`, `t3`, `zc`) with `MAINNET_REFUSED` before writing any `pending` row or calling the CLI, even when the address is on the allow-list. Unknown address formats get `INVALID_ADDRESS`.
6. The live adapter checks the recipient again before it calls `quicksend`.
7. `zcash_receive_address` refuses to return a mainnet address if the wallet ever reports one.

The address checks are prefix checks. They do not decode or verify checksums. A malformed address with a testnet prefix passes these checks and is then rejected by `zingo-cli`, which surfaces as `CHAIN_ERROR`.

## Trust boundaries

```
agent and model  ->  MCP client  ->  zshield-mcp  ->  zingo-cli + wallet file  ->  lightwalletd  ->  Zcash testnet
  (untrusted)         (stdio)        (policy gate)     (holds spend authority)      (testnet.zec.rocks)
```

- **Agent to server.** The agent is untrusted. Any tool argument may be hostile, including text produced by prompt injection. Every argument is validated, every payment goes through policy, and every call writes an audit row.
- **Operator to server.** The person who sets the environment variables, `config/default.yaml`, and the allow-list file controls the policy. The server trusts them completely. There is no signature or second approval on policy files.
- **Server to zingo-cli.** The server trusts `zingo-cli` to build and send exactly the payment it was asked for, and to report balances and history honestly. The binary path comes from `ZINGO_BIN`. Whoever controls that path controls the keys.
- **zingo-cli to lightwalletd.** Balances and history come from a public lightwalletd, by default `testnet.zec.rocks:443`. A malicious or broken server could hide transactions or show stale data. It cannot spend funds. It does see your IP address and when you broadcast.
- **MCP transport.** The server speaks MCP over stdio to one local client. There is no network listener and no authentication. Whoever can start the process or write to its stdin can call every tool.

## Audit log

- Every tool call that reaches the server's handler and is within the rate limit writes at least one JSONL row. Calls over the rate limit are counted in one summary row per minute instead. A call whose arguments have the wrong JSON type, such as a boolean `amount_zec`, or a recipient, memo, or amount string over its size limit, is refused by the MCP SDK's schema check before the handler runs, so it gets an error but no audit row. This is on purpose: those calls never reach policy or the chain, and writing them down would give a hostile caller a cheap way to grow the log. A payment that passes policy writes a `pending` row before the send and a result row after it, linked by `call_id`. If the `pending` row cannot be written, nothing is sent and the call fails with `AUDIT_WRITE_FAILED`.
- Rows are synced to disk (`fsync` on the file, and on the directory for a new file) before the server continues, so a crash or power cut after the send cannot lose the `pending` row. A failed write is retried, then sent to a fallback file, then to stderr. Only a `pending` row that reaches neither file blocks the send.
- If the result row cannot be written after a send, the tool still returns the txid with an `audit_warning`. Throwing there would hide a real payment and invite a retry that pays twice. The `pending` row remains as the record.
- Rejected and failed calls record a stable `code`, such as `CAP_EXCEEDED` or `NOT_ALLOWLISTED`.
- Read-only tool rows hold no balances, addresses, or transaction details.
- The audit log is the human trail, not the source of truth. Idempotency, status, and recovery read the payment store in the wallet directory (`.zshield-state`), so editing or forging an audit row changes no payment state. Each audit dir's log is imported into the store once, the first time a server opens it with that dir.
- At startup the audit dir, the fallback file, and the store are checked: a symlink or another owner stops the server, and loose modes are set to `700` for folders and `600` for files. Writes open files with `O_NOFOLLOW` and check the owner of the open file.
- A lightwalletd URL with a user, password, query, or fragment is refused unless `ZSHIELD_ALLOW_URL_CREDENTIALS=1`. With it, those parts are replaced in every response, error, and audit row. They are still on the `zingo-cli` command line, because it takes the server only there.

Limits today:

- "Append-only" is a convention, not an enforcement. The files are plain JSONL. Anyone who can write to `AUDIT_DIR` can edit or delete rows, and nothing would detect it. There is no hash chain, signature, or remote copy.
- Payment rows store the recipient address, the amount, and the memo in plaintext. Treat the audit directory as sensitive.
- Each row is at most 8 KiB. A recipient too long to be an address is stored as a 64-character prefix plus its SHA-256.

## The viewing-key fingerprint

Each payment row has a `view_key_fingerprint`. It is the first 16 hex characters of `sha256(salt | UFVK)`:

- In testnet mode the UFVK is the wallet's real unified full viewing key, read with `zingo-cli export_ufvk` (see `getViewingKey` in `src/chain/live.ts`). Only a testnet key (`uviewtest1...`) is accepted.
- In mock mode it is a fixed fake key, `MOCK_UFVK` in `src/chain/mock.ts`, so mock rows are deterministic.
- Every row of every call carries it, including `pending`, `rejected`, and `error` rows. All rows from one wallet share one value under a given salt.
- If the key cannot be read, the row records `null`. A call that passes policy is then refused with `VIEWKEY_UNAVAILABLE` and nothing is sent.

What it gives an auditor: holding the UFVK and the salt, they can recompute the fingerprint and confirm which wallet a log belongs to. With the UFVK they can also decrypt that wallet's transactions on chain and match each `ok` row to its txid. The tool response carries the same `call_id` as the audit rows, so a receipt can be matched to its rows.

What it does not give: it is not a signature. Anyone who knows the UFVK and the salt can compute the fingerprint and write fake rows with it. The fingerprint is 64 bits, which is fine for telling wallets apart but is not a security proof. With the default salt, `dev-only-change-me`, anyone holding the UFVK can confirm it matches a log. Change the salt if that matters.

## Threats and mitigations

| Threat | Mitigation | What is left |
|--------|------------|--------------|
| Prompt injection makes the agent pay an attacker | Recipient must be on the allow-list, an exact string match | An attacker can still steer payments to any allow-listed address |
| Agent pays too much in one go | Hard per-call cap, compared in integer zatoshis | None for a single call |
| Agent drains the wallet with many small payments | The tool call rate limit slows this down, but it is not a spending limit | There is no daily or rolling cap and no human approval step. At the default rate limit an agent can still make up to 60 payments a minute. Total loss is bounded only by the wallet balance. Fund the wallet with only what you can lose |
| Concurrent calls race each other | One send at a time per wallet. A second send waits up to `SEND_QUEUE_WAIT_MS`, then gets `BUSY`. The lock is a lease file in the payment store (`.zshield-state/wallet.lock`, created with `O_EXCL` and mode 0600) with a random token, the holder's lease time, and a renewal counter, renewed every quarter of `ZSHIELD_LOCK_LEASE_MS`. Sends, syncs, and recovery all take it. A lease whose process is gone, or not renewed for the longer of the holder's and the waiter's lease time, is broken, by moving it aside and re-checking its exact content first. The holder checks that the file is still its own and renewed on time right before binding a key, right before the send, and at the moment `zingo-cli` starts, and stops if not. Two wallet holders never overlap, whatever the payment keys: every `zingo-cli` process is started through a `perl` wrapper that takes an exclusive `flock` on `.zshield-state/zingo.flock`, inherited by `zingo-cli` itself, so a frozen or late parent cannot start a second wallet process beside the first. A send also has a start deadline after which it is not started. Each `idempotency_key` is bound by an exclusive hard link before the send, so two calls with one key cannot both send | Concurrent calls can each pass the per-call cap. There is no shared budget. The OS lock needs `perl` and a POSIX platform (live mode refuses to run without them, including on Windows), a local filesystem where `flock` works, and does not stop an operator starting `zingo-cli` by hand on the same wallet. Staleness of the soft lease uses the lock file's mtime, so processes on one wallet need a shared clock. Over a network file system the store relies on `O_EXCL` and `link` being atomic |
| A partial sync reports funds as gone | Before the funds check and before `zcash_payment_status`, a bounded sync runs through `zingo-cli`'s prompt and quits cleanly, so the wallet file is saved. Reads after it are offline, so they cannot start a second partial sync. Low funds after an unfinished sync are `WALLET_NOT_SYNCED`. Read tools never wait for the lock; while a send holds it they read offline | A slow server can make each sync use its full timeout. `zcash_payment_status` then answers with `stale: true` |
| Float rounding slips past the cap | Amounts parsed as decimal strings into integer zatoshis; more than 8 decimals is rejected, not rounded | None known |
| Payment lands on mainnet | Seven layers listed under "Mainnet refusal" | Prefix checks only, no checksum decode |
| Payment with no audit trail | `pending` row is written before the send; the send is refused if that write fails | Rows can be edited afterwards by anyone with file access |
| Retry after a timeout pays twice | `idempotency_key`: a repeat with the same key and parameters returns the first outcome and never sends, even after a restart. Post-send audit failures return the txid instead of throwing. A send that times out, is killed, or ends with no txid returns `SEND_UNCONFIRMED` with status `unknown` and lists `possible_sends`, matched on recipient, amount, and memo, never on amount alone. `zcash_payment_status` reports where it stands | A live payment needs a key (`IDEMPOTENCY_KEY_REQUIRED`). A client that retries with a new key can still pay twice. A send the wallet has not synced yet does not show up as a match. The txid is staged on the call before `transmit` runs, so recovery asks about that txid, not about a lookalike |
| Server dies mid-send | The intent and the `pending` row are on disk first. On the next start, recovery reads the whole wallet history once and checks each unsettled call: `confirmed` for the staged txid when it is mined, or for one mined match with the exact memo for a legacy call, `not_found` only with proof (synced wallet, whole history, a server tip that agrees with the wallet and has not gone backwards, a wallet height more than 70 blocks past the height recorded before the send, and at least two hours elapsed), otherwise `unknown`. A txid is credited to one call only. States only move forward. It never resends | A legacy call with no memo is never confirmed from history, and identical payments close together stay `unknown`; both list candidates for a human. History is corroborated against `zingo-cli`'s JSON (`notes all`, `coins all`, `messages`), and an entry the JSON does not vouch for never confirms. A call that died before its key was bound stays `unknown` until the expiry proof, though it never reached the send |
| Send from a stale or empty wallet | In testnet mode, before the `pending` row: the server must answer within `ZINGO_HEALTH_TIMEOUT_MS`, the wallet must be within `HEALTH_MAX_LAG_BLOCKS` of the tip, and spendable must cover amount plus a 0.0001 ZEC fee estimate | The fee is an estimate. A send can still fail at `zingo-cli` for a larger fee |
| Memo leaks data | Memo is capped at 512 UTF-8 bytes. It is exact: no trimming, no control characters, no edge whitespace, and the same string is checked, logged, recorded, and sent | The agent chooses the memo text. Anything in it reaches an allow-listed recipient and the audit log. It is passed over stdin, not argv, so other local users cannot read it from the process list |
| Oversized arguments fill the disk or memory | Recipient is capped at 256 characters, memo at 512 bytes, amount strings at 32 characters, all in the input schema and again in the handler. Each audit row is capped at 8 KiB. Errors do not repeat the caller's text. All tool calls share a per-process limit, `RATE_LIMIT_PER_MIN` (default 60). Calls over it get `RATE_LIMITED` and are counted in one summary row per minute instead of a row each | Within the limit the log still grows by up to 60 rows a minute, each at most 8 KiB. There is no log rotation. The limit is per process, so restarting the server resets it |
| Key theft from disk | Keys stay in the `zingo-cli` wallet file, outside the repo. Testnet mode refuses to start if the wallet directory is open to group or other users, warns about loose file modes, and runs with umask `077` | The file is not encrypted by zshield-mcp. Root and the server's OS user can read it. Permissions are checked only at startup |
| Lying or stale lightwalletd | A reported tip below the wallet's own height, or more than 10 blocks below the highest tip recorded for the wallet, refuses the send. Expiry is anchored on the highest of the server tip, the wallet height, and that mark, and is only proven with a current tip that is not below them | Balances and history are only as good as the server `zingo-cli` talks to. A server that hides transactions can still make a history look empty, which is why proof also needs elapsed time and blocks |
| Hostile allow-list or config edit | None in the server | Whoever can write those files sets policy. The allow-list is cached by file identity, size, mtime, and ctime, and read again when any changes, so an edit takes effect on the next call. On a filesystem with coarse timestamps, a same-size edit within one tick waits for the next change |
| Hostile store or audit file planted by another local user | Startup refuses symlinks and files owned by another user in the audit dir and the store, and tightens loose modes. Store and audit writes never follow a symlink | The check on modes runs at startup. Root and the server's own user can still edit the store |
| Secrets in the lightwalletd URL | Refused at startup unless `ZSHIELD_ALLOW_URL_CREDENTIALS=1`; then redacted from responses, errors, and audit rows | With the opt-in, the URL is visible in the process list |
| Policy resource used to probe the server | Reads of `zshield://policy` count against the rate limit, the allow-list read is cached and bounded (1 MiB, 10,000 entries), and the resource shows no local path | None known |
| Slow or stuck `zingo-cli` | Every timeout and the lease time are checked against a range at startup, and a value outside it stops the server. Read tools time out after `ZINGO_READ_TIMEOUT_MS`, default 120 seconds. Syncs stop after `HEALTH_SYNC_TIMEOUT_MS` or `STATUS_SYNC_TIMEOUT_MS`, default 90 seconds, with a clean quit and then a kill after 15 seconds. Health checks time out after `ZINGO_HEALTH_TIMEOUT_MS`, default 30 seconds. Sends time out after 15 minutes. A failing `export_ufvk` backs off from 1 second to 1 minute, and it is only tried after the cheap policy checks pass, so refused calls never start `zingo-cli` | A stuck send blocks that tool call, and other sends from the wallet get `BUSY`, until the timeout |

## Review findings F-6 to F-11

All six are addressed on this branch, each with a regression test that fails on the code before the fix.

| Finding | Fix | Test |
|---------|-----|------|
| F-6 A failed audit write could lose a row or block on a bad disk | Retry, then a fallback file, then stderr. Reads and post-send rows still answer with `audit_warning`; a `pending` row that cannot be stored refuses the send | `tests/audit-fallback.test.ts` |
| F-7 Audit rows were not synced to disk before the send | `fsync` on the row, and on the directory for a new file | `tests/audit-durable.test.ts` |
| F-8 `possible_txids` matched on amount alone | Match on recipient, amount, and memo from the wallet's outgoing notes, inside a time window, with a confidence level | `tests/send-match.test.ts` |
| F-9 The wallet directory came from `$HOME` and could be relative | Use `os.homedir()`, require an absolute `ZINGO_DATA_DIR`, refuse to start otherwise | `tests/wallet-dir.test.ts` |
| F-10 Every call, even a refused one, ran `export_ufvk`, and a failing one was retried on every call | Read the key after the cheap checks, cache it, and back off on failure | `tests/viewkey-order.test.ts` |
| F-11 The wallet permission check did nothing on Windows | Check the ACL with `icacls`, with opt-in hardening | `tests/winacl.test.ts` |

## Out of scope

- Mainnet and real funds.
- Custody of anyone else's keys, or more than one wallet.
- Multiple users, authentication, or remote access to the MCP server.
- A compromised host, OS user, Node.js runtime, npm dependency, or `zingo-cli` binary.
- Network privacy. Connections to lightwalletd reveal your IP address. There is no Tor or mixnet support in zshield-mcp.
- The correctness of `zingo-cli`, lightwalletd, and the Zcash protocol.
- Denial of service against the server or the wallet.
- Legal and compliance retention of the audit log.

## V12 review of ff2254b

Eleven findings, all addressed on this branch. Each has a test in `tests/v12.test.ts` or `tests/race.test.ts` that fails on ff2254b and passes after. The race tests start separate server processes against one wallet and a fake `zingo-cli`. The design is in [RELIABILITY_DESIGN.md](RELIABILITY_DESIGN.md).

| Finding | Fix |
|---------|-----|
| F-8 History matching saw only recent entries | Recovery and status read the whole history and credit a txid to one call |
| F-11 The Windows ACL check skipped the new record dirs | The ACL check covers the wallet file, the payment store, and the audit dir |
| F-12 Processes with different audit dirs kept separate payment records | One payment store inside the wallet directory, found from the wallet path |
| F-13 Policy reads bypassed the rate limit | `zshield://policy` reads count against `RATE_LIMIT_PER_MIN` |
| F-14 A fixed lock age could break a live send's lock, and timeouts were unbounded | A renewed lease with token and freshness checks before the bind and the send; every timeout bounded |
| F-15 The policy resource showed local paths | Paths removed |
| F-16 Credentials in the lightwalletd URL could leak in errors and rows | Refused by default; redacted when allowed |
| F-17 Legacy audit files kept loose modes and could be forged or symlinked | Startup checks of owner, symlinks, and modes; state comes from the store, not the log |
| F-18 `not_found` and `expired` came from a truncated history | Proof required: synced wallet, whole history, past the expiry height. Otherwise `unknown` |
| F-19 Every key miss rebuilt the index from the whole log | Lookups read one file. The log is imported once per audit dir |
| F-20 A stale recovery could overwrite a newer result | States only move forward; a mined call stays mined |

## V12 run 5 review of d63f5d8

Five findings. Each has a test in `tests/v12r5.test.ts` that fails on d63f5d8 and passes now. The two process tests start separate processes against one lock. The design is in [RELIABILITY_DESIGN.md](RELIABILITY_DESIGN.md).

| Finding | Fix |
|---------|-----|
| F-8 History matches misattributed payments | A match needs equal recipient (or unified address), amount, and memo, and a place after the call started by time or block height. The parser takes the last recipient line of a note, and memos with line breaks or control characters are refused. Identical unsettled calls and unclaimed same amount sends stay `unknown` |
| F-14 A fixed lease allowed duplicate sends, and recovery held one lock across unbounded work | Lease terms live in the lock and are renewed by a heartbeat. The key is re-read after the health check, a fence runs at the moment `zingo-cli` starts, and a process that ignores a stop is killed. Recovery has a call cap, a time budget, a bounded sync and lock wait, and yields to timers |
| F-21 A stale lock race created two holders | The lock stores `leaseMs` and a renewal counter. Staleness uses the longer lease. Breaking moves the file aside, re-reads the exact content, and puts it back unless it is identical and still stale |
| F-22 A low server tip allowed a false proof of non-send | The anchor is the highest of the tip, the wallet height, and a rising mark. A tip below the wallet or the mark refuses the send. Proof needs a current trustworthy tip, a larger margin, and two hours. Older calls without the wallet height stay `unknown` |
| F-23 A failed txid replayed as a success | A `failed` state above `sent`. Status records it, and a same-key replay returns `PAYMENT_FAILED`. The key is not reused after a failure |

## V12 sweep after run 5

Every V12 note, with its status at HEAD and the test that proves it, is in [V12_CHECKLIST.md](V12_CHECKLIST.md). The sweep added:

| Area | Fix |
|------|-----|
| Two wallet holders (F-14, F-21) | An OS `flock` on `.zshield-state/zingo.flock`, held by the `zingo-cli` process itself through a `perl` wrapper. A start deadline on sends. Tests: `tests/v12r6.test.ts`, `tests/race.test.ts` |
| Memo exactness (F-8) | One validated string everywhere: no trimming, no control characters, no edge whitespace. Tests: `tests/v12r6.test.ts`, `tests/v12r7.test.ts` |
| Live keys (F-12, F-14) | A live payment needs an `idempotency_key` |
| Send identity (F-8, F-18, F-20) | A two-stage send binds the txid before `transmit`. Recovery uses that txid. A lone memo-less history match is never proof of identity, and status never claims a guessed candidate. Tests: `tests/v12r7.test.ts`, `tests/identity.test.ts`, `tests/status.test.ts` |
| History corroboration (F-8) | Entries are checked against `notes all`, `coins all` and `messages` JSON (kind, amount, recipient, memo). Tests: `tests/corroborate.test.ts` |
| Demo | `npm run demo:testnet` passes an idempotency key. Test: `tests/demo.test.ts` |

## Where to look in the code

- Policy checks: `src/policy/caps.ts`, `src/policy/amount.ts`, `src/policy/allowlist.ts`
- Payment flow and audit ordering: `src/tools/pay.ts`
- Payment store, send lock, wallet lease, and startup recovery: `src/payments/`
- Safe file writes and URL redaction: `src/fsafe.ts`, `src/redact.ts`
- Bounded wallet sync: `src/chain/sync.ts`
- OS wallet lock: `src/chain/walletlock.ts`
- History corroboration: `src/chain/corroborate.ts`
- Payment status: `src/tools/status.ts`
- Read-only tools: `src/tools/read.ts`, `src/tools/balance.ts`, `src/tools/address.ts`, `src/tools/history.ts`
- Network checks: `src/chain/network.ts`
- Testnet adapter and viewing-key read: `src/chain/live.ts`
- Fingerprint hash, durable writes, and the fallback file: `src/audit/log.ts`
- Windows ACL check: `src/chain/winacl.ts`
- Startup refusal of mainnet and of an exposed wallet: `src/config.ts`, `src/startup.ts`, `src/chain/perms.ts`, `src/index.ts`
- Stable codes: `src/errors.ts`
