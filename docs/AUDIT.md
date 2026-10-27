# Audit log format

Append-only JSON Lines under `AUDIT_DIR` (default `./audits/`), one file per UTC day: `YYYY-MM-DD.jsonl`.

## Fields

| Field | Type | Notes |
|-------|------|--------|
| `ts` | string (ISO-8601) | When the tool call finished |
| `tool` | `"zcash_pay"` | Always |
| `amount_zec` | string or number | Requested amount as passed to the tool |
| `amount_zats` | string? | Amount in integer zatoshis (1 ZEC = 100,000,000). Absent when the amount was invalid |
| `recipient` | string | Address as passed to the tool |
| `allowlist_hit` | boolean | Whether recipient was on the allow-list |
| `cap_zec` | string or number | Active hard per-call cap |
| `status` | `ok` \| `rejected` \| `error` | Outcome |
| `mock_txid` | string? | Present on success in mock mode |
| `view_key_fingerprint` | string | `sha256(salt \| viewKeyMaterial)[0:16]`, **never** the raw key |
| `error` | string? | Policy or runtime message |
| `memo` | string? | Optional memo |

## Retention

Rotate or archive `audits/*.jsonl` as your compliance needs require. Do not commit live audit files (gitignored).
