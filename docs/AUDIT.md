# Audit log format

Append-only JSON Lines under `AUDIT_DIR` (default `./audits/`), one file per UTC day: `YYYY-MM-DD.jsonl`.

Every call writes at least one row. A call that passes policy writes a `pending` row before the chain send, then a result row (`ok` with the txid, `error`, or `unknown`) after it. `unknown` means the send was started and may have been broadcast, but no txid came back, for example because `zingo-cli` timed out. Both rows share a `call_id`. A call rejected by policy writes a single `rejected` row and never reaches the chain. If the `pending` row cannot be written, the payment is not sent. If the result row cannot be written after a send, the tool still returns the txid and adds an `audit_warning` so the caller does not retry and pay twice. The `pending` row stays in the log as the record of that send.

## Durability and the fallback file

Each row is written with `fsync` on the file, and on a new file also on its directory, before the server goes on. On a power cut the `pending` row is on disk before anything is sent. A write is tried twice. If the main log still fails, the row goes to the fallback file (`AUDIT_FALLBACK_PATH`, default `audit-fallback.jsonl` next to `AUDIT_DIR`), created with mode `600` and also synced. If that fails too, the row is printed to stderr and the response carries `audit_warning`. For a `pending` row that means the payment is refused with `AUDIT_WRITE_FAILED`. Read the fallback file together with the daily files.

## Idempotency, replay, and recovery rows

The server rebuilds its view of past payments from these files (and the fallback file) at startup. That is how an `idempotency_key` survives a restart and how interrupted sends are found.

- The `pending` row of a call with a key carries `idempotency_key` and `params_sha256`, the hash of the amount in zatoshis, recipient, and memo.
- A repeat call with the same key writes its own row with status `replayed`, its own `call_id`, and `replay_of` set to the first call's `call_id`. It sends nothing.
- At startup, every `pending` row with no result row gets a recovery row: `tool` `zcash_pay_recovery`, the original `call_id`, `status` (`confirmed`, `not_found`, or `unknown`), `txid`, `block_height`, and `confidence` when a match was found, `possible_sends` when there were candidates but no single mined match, `idempotency_key` when the call had one, and a plain `note` saying why. `confirmed` and `not_found` are final; `unknown` is checked again on the next start.

## Fields

| Field | Type | Notes |
|-------|------|--------|
| `ts` | string (ISO-8601) | When the row was written |
| `tool` | `"zcash_pay"` | Always |
| `call_id` | string | Same value on the `pending` row and its result row |
| `amount_zec` | string or number | Requested amount as passed to the tool. A string longer than 32 characters is cut |
| `amount_zats` | string? | Amount in integer zatoshis (1 ZEC = 100,000,000). Absent when the amount was invalid |
| `recipient` | string | Address as passed to the tool. One longer than 256 characters is cut to its first 64, and `recipient_sha256` holds the hash of the full value |
| `recipient_sha256` | string? | Only on rows with an oversized recipient |
| `allowlist_hit` | boolean | Whether recipient was on the allow-list |
| `cap_zec` | string or number | Active hard per-call cap |
| `status` | `pending` \| `ok` \| `rejected` \| `error` \| `unknown` \| `replayed` | `pending` is written before the send; `replayed` marks a repeat with a used key; the others are outcomes |
| `mock_txid` | string? | Present on success in mock mode |
| `view_key_fingerprint` | string or null | `sha256(salt \| UFVK)[0:16]`, the same on every row from one wallet. **Never** the key itself. `null` when the key could not be read, in which case nothing is sent |
| `code` | string? | Stable machine code on `rejected`, `error`, and `unknown` rows, such as `CAP_EXCEEDED`. See the README for the full list |
| `error` | string? | Policy or runtime message |
| `memo` | string? | Optional memo, at most 512 UTF-8 bytes |
| `possible_sends` | object[]? | `unknown` rows only. Recent sent transactions in wallet history to the same recipient with the same amount, and the same memo when one was given, found right after the send failed. Each has `txid`, `confidence` (`high`, `medium`, `low`), `matched` (the fields that matched), and `status`. Possibly empty |
| `possible_txids` | string[]? | `unknown` rows only. The txids from `possible_sends` |
| `idempotency_key` | string? | The key the caller passed |
| `params_sha256` | string? | `pending` rows with a key: the hash the key is bound to |
| `replay_of` | string? | `replayed` rows: the `call_id` of the first call |
| `truncated` | boolean? | Present when the row was shortened to fit the size limit |

Each row is capped at 8 KiB (8192 bytes of UTF-8 JSON). If a row would be larger, string fields over 1024 characters are cut and marked `...[truncated]`. If it is still too large, only the identifying fields are kept (`ts`, `tool`, `call_id`, `status`, `mock_txid`, `recipient_sha256`, `view_key_fingerprint`, `code`, `possible_txids`, `possible_sends`, `txid`, `block_height`, and `idempotency_key`). The tool response carries the same bounded row.

## Read-only tool rows

Read-only tools (`zcash_balance`, `zcash_receive_address`, `zcash_history`, `zcash_payment_status`) write one row per call with these fields: `ts`, `tool`, `call_id`, `mode` (`mock` or `live`), `status` (`ok`, `rejected`, or `error`), `code` and `error` when the call failed, for `zcash_history` the `limit` that was asked for, and for `zcash_payment_status` the `ref_call_id` of the payment it found. They never record balances, addresses, or transaction details.

## Rate limit rows

Calls refused with `RATE_LIMITED` do not get a row each, so a flood of calls cannot grow the log faster than the limit allows. Instead the server counts them and writes one summary row when the minute ends, or on the next call after it: `ts`, `tool` (`rate_limit`), `status` (`rejected`), `code` (`RATE_LIMITED`), `window_start`, `limit_per_min`, `refused_calls`, and `refused_by_tool` (a count per tool name). It holds nothing from the refused calls. If the server stops before the summary is written, that count is lost.

## Retention

Rotate or archive `audits/*.jsonl` as your compliance needs require. Do not commit live audit files (gitignored).
