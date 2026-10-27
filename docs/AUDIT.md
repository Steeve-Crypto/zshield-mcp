# Audit log format

Append-only JSON Lines under `AUDIT_DIR` (default `./audits/`), one file per UTC day: `YYYY-MM-DD.jsonl`.

Every call writes at least one row. A call that passes policy writes a `pending` row before the chain send, then a result row (`ok` with the txid, or `error`) after it. Both rows share a `call_id`. A call rejected by policy writes a single `rejected` row and never reaches the chain. If the `pending` row cannot be written, the payment is not sent. If the result row cannot be written after a send, the tool still returns the txid and adds an `audit_warning` so the caller does not retry and pay twice. The `pending` row stays in the log as the record of that send.

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
| `status` | `pending` \| `ok` \| `rejected` \| `error` | `pending` is written before the send; the others are outcomes |
| `mock_txid` | string? | Present on success in mock mode |
| `view_key_fingerprint` | string | `sha256(salt \| viewKeyMaterial)[0:16]`, **never** the raw key |
| `error` | string? | Policy or runtime message |
| `memo` | string? | Optional memo, at most 512 UTF-8 bytes |
| `truncated` | boolean? | Present when the row was shortened to fit the size limit |

Each row is capped at 8 KiB (8192 bytes of UTF-8 JSON). If a row would be larger, string fields over 1024 characters are cut and marked `...[truncated]`. If it is still too large, only the identifying fields are kept (`ts`, `tool`, `call_id`, `status`, `mock_txid`, `recipient_sha256`, `view_key_fingerprint`, and the `code` once codes exist). The tool response carries the same bounded row.

## Read-only tool rows

Read-only tools (`zcash_balance`, `zcash_receive_address`, `zcash_history`) write one row per call with these fields: `ts`, `tool`, `call_id`, `mode` (`mock` or `live`), `status` (`ok`, `rejected`, or `error`), `error` when the call failed, and for `zcash_history` the `limit` that was asked for. They never record balances, addresses, or transaction details.

## Retention

Rotate or archive `audits/*.jsonl` as your compliance needs require. Do not commit live audit files (gitignored).
