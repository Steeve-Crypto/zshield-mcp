# Audit log format

Append-only JSON Lines under `AUDIT_DIR` (default `./audits/`), one file per UTC day: `YYYY-MM-DD.jsonl`.

Every call writes at least one row. A call that passes policy writes a `pending` row before the chain send, then a result row (`ok` with the txid, `error`, or `unknown`) after it. `unknown` means the send was started and may have been broadcast, but no txid came back, for example because `zingo-cli` timed out. Both rows share a `call_id`. A call rejected by policy writes a single `rejected` row and never reaches the chain. If the `pending` row cannot be written, the payment is not sent. If the result row cannot be written after a send, the tool still returns the txid and adds an `audit_warning` so the caller does not retry and pay twice. The `pending` row stays in the log as the record of that send.

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
| `status` | `pending` \| `ok` \| `rejected` \| `error` \| `unknown` | `pending` is written before the send; the others are outcomes |
| `mock_txid` | string? | Present on success in mock mode |
| `view_key_fingerprint` | string or null | `sha256(salt \| UFVK)[0:16]`, the same on every row from one wallet. **Never** the key itself. `null` when the key could not be read, in which case nothing is sent |
| `code` | string? | Stable machine code on `rejected`, `error`, and `unknown` rows, such as `CAP_EXCEEDED`. See the README for the full list |
| `error` | string? | Policy or runtime message |
| `memo` | string? | Optional memo, at most 512 UTF-8 bytes |
| `possible_txids` | string[]? | `unknown` rows only. Recent sent transactions in wallet history with the same amount, found right after the send failed. Possibly empty |
| `truncated` | boolean? | Present when the row was shortened to fit the size limit |

Each row is capped at 8 KiB (8192 bytes of UTF-8 JSON). If a row would be larger, string fields over 1024 characters are cut and marked `...[truncated]`. If it is still too large, only the identifying fields are kept (`ts`, `tool`, `call_id`, `status`, `mock_txid`, `recipient_sha256`, `view_key_fingerprint`, `code`, and `possible_txids`). The tool response carries the same bounded row.

## Read-only tool rows

Read-only tools (`zcash_balance`, `zcash_receive_address`, `zcash_history`) write one row per call with these fields: `ts`, `tool`, `call_id`, `mode` (`mock` or `live`), `status` (`ok`, `rejected`, or `error`), `code` and `error` when the call failed, and for `zcash_history` the `limit` that was asked for. They never record balances, addresses, or transaction details.

## Rate limit rows

Calls refused with `RATE_LIMITED` do not get a row each, so a flood of calls cannot grow the log faster than the limit allows. Instead the server counts them and writes one summary row when the minute ends, or on the next call after it: `ts`, `tool` (`rate_limit`), `status` (`rejected`), `code` (`RATE_LIMITED`), `window_start`, `limit_per_min`, `refused_calls`, and `refused_by_tool` (a count per tool name). It holds nothing from the refused calls. If the server stops before the summary is written, that count is lost.

## Retention

Rotate or archive `audits/*.jsonl` as your compliance needs require. Do not commit live audit files (gitignored).
