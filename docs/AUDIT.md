# Audit log format

Append-only JSON Lines under `AUDIT_DIR` (default `./audits/`), one file per UTC day: `YYYY-MM-DD.jsonl`.

Every call writes at least one row. A call that passes policy writes a `pending` row before the chain send, then a result row (`ok` with the txid, or `error`) after it. Both rows share a `call_id`. A call rejected by policy writes a single `rejected` row and never reaches the chain. If the `pending` row cannot be written, the payment is not sent. If the result row cannot be written after a send, the tool still returns the txid and adds an `audit_warning` so the caller does not retry and pay twice. The `pending` row stays in the log as the record of that send.

## Fields

| Field | Type | Notes |
|-------|------|--------|
| `ts` | string (ISO-8601) | When the row was written |
| `tool` | `"zcash_pay"` | Always |
| `call_id` | string | Same value on the `pending` row and its result row |
| `amount_zec` | number | Requested amount |
| `recipient` | string | Address as passed to the tool |
| `allowlist_hit` | boolean | Whether recipient was on the allow-list |
| `cap_zec` | number | Active hard per-call cap |
| `status` | `pending` \| `ok` \| `rejected` \| `error` | `pending` is written before the send; the others are outcomes |
| `mock_txid` | string? | Present on success in mock mode |
| `view_key_fingerprint` | string | `sha256(salt \| viewKeyMaterial)[0:16]`, **never** the raw key |
| `error` | string? | Policy or runtime message |
| `memo` | string? | Optional memo |

## Retention

Rotate or archive `audits/*.jsonl` as your compliance needs require. Do not commit live audit files (gitignored).
