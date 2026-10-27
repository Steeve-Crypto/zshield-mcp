<p align="center"><img src="docs/images/logo.png" alt="zshield-mcp logo" width="160"></p>

![zshield-mcp banner](docs/images/banner.png)

# zshield-mcp

Open-source **MCP server** that exposes `zcash_pay` for agent-initiated **shielded ZEC** payments under human policy, plus read-only wallet tools that never move funds. `zcash_pay` is guarded by:

- **Hard per-call spending cap**
- **Recipient allow-list**
- **Append-only viewing-key fingerprinted audit log**

Spend keys never belong in the model. Mock chain by default. A live adapter sends real shielded payments on Zcash **testnet only** through zingo-cli.

![Flow: AI agent to zshield-mcp to Zcash testnet](docs/images/flow.png)

## Purpose

Agents need a payment tool they can call safely. This server enforces policy *before* any payment attempt, records an audit row for every call (success or reject), and stores only a short fingerprint in place of key material.

Built as a concrete, minimal artifact for design-partner review of shielded agent-payment MCP surfaces (see Zcash Community Grants discussions around agent payment tooling over MCP).

## Demo

Real output of `npm run demo:mock` (mock chain, no coins spent): one payment allowed, one blocked by the spending cap, one blocked by the allow-list, then the audit log.

![Mock demo terminal output](docs/images/demo.png)

## Quickstart

```bash
git clone <this-repo> zshield-mcp && cd zshield-mcp
cp .env.example .env
npm install
npm test
npm run typecheck   # type-checks src, tests, and scripts
npm run build
npm start   # stdio MCP server
```

Point your MCP client (Cursor, Claude Desktop, etc.) at:

```json
{
  "mcpServers": {
    "zshield": {
      "command": "node",
      "args": ["/absolute/path/to/zshield-mcp/dist/index.js"],
      "env": {
        "SPENDING_CAP_ZEC": "0.1",
        "ALLOWLIST_PATH": "/absolute/path/to/zshield-mcp/allowlists/recipients.example.json",
        "CHAIN_MODE": "mock",
        "AUDIT_DIR": "/absolute/path/to/zshield-mcp/audits"
      }
    }
  }
}
```

Or during development: `"command": "npx", "args": ["tsx", "src/index.ts"]` with `cwd` set to the repo.

## Tool: `zcash_pay`

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `amount_zec` | string or number | yes | Decimal ZEC such as `"0.05"`, at most 8 decimals and 32 characters. Must be `> 0` and `<= SPENDING_CAP_ZEC`, compared as integer zatoshis. Never rounded |
| `recipient` | string | yes | At most 256 characters, visible ASCII only. Must exactly match an allow-list `address` |
| `memo` | string | no | Optional memo, at most 512 UTF-8 bytes (the Zcash memo size) |

Oversized or malformed input is rejected before anything else runs. Error messages never repeat the amount text, recipient, or memo, and errors from `zingo-cli` have them replaced with `[recipient]` and `[memo]`. Each audit row is capped at 8 KiB, see [docs/AUDIT.md](docs/AUDIT.md).

## Resource: `zshield://policy`

Read this before paying to see the rules the server will apply. It is JSON, read fresh on every request:

```json
{
  "mode": "mock",
  "chain_adapter": "mock",
  "mainnet": "refused",
  "limits": {
    "per_call_cap_zec": "0.1",
    "per_call_cap_zats": "10000000",
    "daily_or_rolling_cap": "none",
    "amount_unit": "integer zatoshis, 1 ZEC = 100000000",
    "max_decimals": 8,
    "tool_calls_per_min": 60
  },
  "allowlist": {
    "path": "/abs/path/allowlists/recipients.example.json",
    "size": 2,
    "match": "exact address string"
  },
  "audit": {
    "dir": "/abs/path/audits",
    "every_call_audited": true,
    "pending_row_before_send": true,
    "rate_limited_calls": "not audited one by one; counted in one summary row per minute"
  },
  "tools": {
    "payment": ["zcash_pay"],
    "read_only": ["zcash_balance", "zcash_receive_address", "zcash_history"]
  }
}
```

`mode` is `mock` or `testnet`. `size` counts unique addresses in the allow-list file right now. If the file cannot be read, `size` is `null`, `error` says why, and every `zcash_pay` call is rejected until it is fixed. The cap is per call only; there is no daily or rolling limit yet. The fingerprint salt is never shown.

### Rejection codes

Every failed `zcash_pay` call returns `isError: true` and a body like this:

```json
{
  "ok": false,
  "status": "rejected",
  "code": "CAP_EXCEEDED",
  "message": "Amount 0.5 ZEC exceeds hard per-call spending cap of 0.1 ZEC.",
  "error": "Amount 0.5 ZEC exceeds hard per-call spending cap of 0.1 ZEC."
}
```

Branch on `code`. It is stable. `message` is for people and may change. `error` holds the same text as `message` for older clients. The audit row for the call records the same `code`.

`status` is `rejected` when policy refused the call. Nothing was sent and there is no `pending` row.

| Code | Meaning |
|------|---------|
| `INVALID_RECIPIENT` | Recipient is empty, longer than 256 characters, or has characters that cannot appear in an address. The value is not repeated in the message |
| `INVALID_MEMO` | Memo is longer than 512 UTF-8 bytes |
| `INVALID_AMOUNT` | Amount is not a positive decimal with at most 8 decimals, or is above the 21,000,000 ZEC supply |
| `CAP_EXCEEDED` | Amount is above `SPENDING_CAP_ZEC` |
| `INVALID_CAP` | The configured cap itself is not valid, so every payment is refused |
| `MAINNET_REFUSED` | Testnet mode got a mainnet address (`u1`, `zs1`, `t1`, `t3`, `zc`). Refused even if it is on the allow-list |
| `INVALID_ADDRESS` | Testnet mode got an address from no known Zcash network |
| `NOT_ALLOWLISTED` | Recipient is not an exact match for an allow-list entry |
| `ALLOWLIST_UNAVAILABLE` | The allow-list file is missing or malformed, so every payment is refused |
| `INVALID_IDEMPOTENCY_KEY` | `idempotency_key` is empty, longer than 128 characters, or has characters other than letters, digits, `.`, `_`, `:`, `-` |
| `IDEMPOTENCY_CONFLICT` | `idempotency_key` was already used for a payment with a different amount, recipient, or memo |

`status` is `error` when something failed outside policy:

| Code | Meaning |
|------|---------|
| `AUDIT_WRITE_FAILED` | The `pending` audit row could not be written, so the payment was not sent |
| `VIEWKEY_UNAVAILABLE` | The wallet's viewing key could not be read for the audit fingerprint, so the payment was not sent |
| `CHAIN_ERROR` | Policy passed and the send was attempted, but `zingo-cli` reported an error, so nothing was broadcast. A `pending` row exists |
| `BUSY` | Another payment from the same wallet was still running after `SEND_QUEUE_WAIT_MS`. Nothing was sent and there is no `pending` row. Try again shortly |
| `WALLET_NOT_SYNCED` | Testnet mode: the wallet is more than `HEALTH_MAX_LAG_BLOCKS` blocks behind the chain tip. Nothing was sent. Sync the wallet first |
| `INSUFFICIENT_FUNDS` | Testnet mode: spendable balance is below the amount plus the estimated fee. Nothing was sent |
| `CHAIN_UNREACHABLE` | Testnet mode: the lightwalletd server did not report the chain tip within `ZINGO_HEALTH_TIMEOUT_MS`. Nothing was sent |
| `CONFIG_ERROR` | The server is misconfigured, for example testnet mode without the testnet adapter. Nothing was sent |

`status` is `unknown` when the send was started but its result is not known:

| Code | Meaning |
|------|---------|
| `SEND_UNCONFIRMED` | `zingo-cli` timed out, was killed, or finished without a txid or an error. The payment may have been broadcast. Do not retry yet: call `zcash_history` and look for a sent transaction with this amount. The response and the audit row list `possible_txids`, recent sent transactions of the same amount found in wallet history right after the failure. An empty list does not prove nothing went out, because the wallet may not have synced the send yet |
| `PAYMENT_PENDING` | A repeat call with an `idempotency_key` whose first call has a `pending` row and no result yet. Nothing was sent again |

Checks run in this order, and the first failure decides the code: recipient and memo size, allow-list file, amount, cap, address network (testnet mode only), allow-list match.

Any tool call over the rate limit is refused before the tool runs:

| Code | Meaning |
|------|---------|
| `RATE_LIMITED` | More than `RATE_LIMIT_PER_MIN` tool calls this minute in this server process. Nothing was sent or read. Wait and try again. These calls get no audit row each; their count goes into one summary row per minute |

Read-only tools use the same shape. `zcash_history` returns `INVALID_LIMIT` with status `rejected` for a bad `limit`. A wallet read failure is `CHAIN_ERROR`, and a wallet that reports a mainnet address is `MAINNET_REFUSED`.

## Read-only tools

These tools never send anything. Each call writes one audit row with the tool name, mode, and outcome. The row does not hold balances, addresses, or transaction data. If that row cannot be written, the tool still answers and adds an `audit_warning`, since nothing moved.

### `zcash_balance`

No arguments. Returns the wallet balance in integer zatoshis and as a ZEC string:

```json
{
  "ok": true,
  "mode": "mock",
  "confirmed_zats": "1000000000",
  "confirmed_zec": "10",
  "spendable_zats": "1000000000",
  "spendable_zec": "10",
  "unconfirmed_zats": "0",
  "unconfirmed_zec": "0"
}
```

Zatoshi values are strings so they stay exact in JSON. `confirmed` is the sum of confirmed funds across every pool. `spendable` is what the wallet can send right now. In testnet mode the values come from `zingo-cli balance` and `zingo-cli spendable_balance`, as of the wallet's last sync.

In mock mode the wallet starts with 10 ZEC. Each mock payment takes the amount plus a 0.0001 ZEC fee, and a payment larger than the balance fails with an insufficient funds error.

### `zcash_receive_address`

No arguments. Returns the wallet's current unified address, which is the newest one on account 0:

```json
{
  "ok": true,
  "mode": "live",
  "address": "utest14dsty0x36s…",
  "network": "testnet"
}
```

In testnet mode it comes from `zingo-cli addresses`, and a mainnet address is refused. In mock mode it is a fixed fake address that starts with `u1mockwallet`.

### `zcash_history`

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `limit` | integer | no | How many recent transactions to return. Default `10`, allowed `1` to `50` |

Returns recent transactions, newest first. Ones that are not confirmed yet come first.

`status` is what `zingo-cli` reports. `confirmed` means mined, and `block_height` is the block it was mined in. `transmitted` means the wallet sent it but has not seen it in a block yet, which can simply mean the wallet has not synced that far. `mempool` and `calculated` are also not mined yet. `failed` means it expired or was rejected without being mined, so its funds are spendable again. For anything not confirmed, `block_height` is absent and `target_height` is the height it was built for. It expires unmined about 40 blocks after that.

```json
{
  "ok": true,
  "mode": "live",
  "count": 1,
  "transactions": [
    {
      "txid": "59d9cb1b5a47…",
      "time": "2026-10-13T00:52:06.000Z",
      "status": "confirmed",
      "block_height": 4493943,
      "kind": "sent",
      "value_zats": "100000",
      "value_zec": "0.001",
      "fee_zats": "10000",
      "explorer_url": "https://blockexplorer.one/zcash/testnet/tx/59d9cb1b5a47…"
    }
  ]
}
```

A limit outside `1` to `50`, or one that is not a whole number, is rejected before the wallet is asked, and the rejection is audited. Memos and counterparties are not returned. In testnet mode the list comes from `zingo-cli transactions`. In mock mode it lists the mock funding receive and every mock payment made in this server session.

## Config: caps & allow-list

Precedence: **environment variables** override `config/default.yaml`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SPENDING_CAP_ZEC` | `0.1` | Hard max ZEC **per tool call**, positive with at most 8 decimals |
| `ALLOWLIST_PATH` | `./allowlists/recipients.example.json` | JSON allow-list |
| `CHAIN_MODE` | `mock` | `mock` or `testnet` (any other live value exits) |
| `AUDIT_DIR` | `./audits` | JSONL audit directory |
| `VIEW_KEY_FINGERPRINT_SALT` | from yaml | Salt for view-key fingerprints |
| `RATE_LIMIT_PER_MIN` | `60` | Tool calls allowed per minute across all tools in one server process, 1 to 10000. Calls over it get `RATE_LIMITED` |

Allow-list shape:

```json
{
  "recipients": [
    { "address": "u1…", "label": "Demo merchant" }
  ]
}
```

## Audit log format

JSONL per day: `audits/YYYY-MM-DD.jsonl`. A call that passes policy writes a `pending` row before the chain send and a result row after it, linked by `call_id`. A rejected call writes one `rejected` row. Example success line:

```json
{"ts":"2026-10-05T19:00:00.000Z","tool":"zcash_pay","call_id":"3f0c…","amount_zec":0.05,"amount_zats":"5000000","recipient":"u1…","allowlist_hit":true,"cap_zec":0.1,"status":"ok","mock_txid":"mock_…","view_key_fingerprint":"a1b2c3d4e5f60718","memo":"test"}
```

The viewing key itself is **never** written or returned, only a short fingerprint of it. `view_key_fingerprint` is the first 16 hex characters of `sha256(salt | UFVK)`, where UFVK is the wallet's unified full viewing key. In testnet mode the server reads it once per process with `zingo-cli export_ufvk` in an offline session and keeps it in memory. Mock mode uses a fixed fake key. Every row from one wallet carries the same fingerprint, so anyone holding the UFVK and the salt can confirm which wallet wrote a log, then match each row to the chain by its txid. The tool response includes the same `call_id` as the audit rows. See [docs/AUDIT.md](docs/AUDIT.md) and [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

## Security model

[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) covers where keys live, what the server can and cannot do, the trust boundaries, threats and mitigations, and what is out of scope. Read it before pointing this at a funded wallet. The short version: the cap is per call only, so many small payments can still drain the wallet, and the audit log is not tamper-evident.

## Layout

```
src/policy/   caps + allow-list
src/chain/    mock adapter, testnet adapter, address checks
src/audit/    JSONL writer + fingerprint
src/tools/    zcash_pay and the read-only tools
src/server.ts MCP registration
tests/        happy path + rejections
```

## Testnet mode

What it does: with `CHAIN_MODE=testnet` the server checks cap, allow-list, and address network first, writes the audit row, and only then calls `zingo-cli quicksend` against a public testnet lightwalletd (default `https://testnet.zec.rocks:443`). Mainnet addresses (`u1`, `zs1`, `t1`) are rejected; testnet ones (`utest`, `ztestsapling`, `tm`) are accepted. `CHAIN_MODE=live` alone is refused.

Setup:

```bash
# build zingo-cli (Rust)
git clone https://github.com/zingolabs/zingolib && cd zingolib
cargo build --release -p zingo-cli
# create a fresh testnet wallet outside the repo and print its address
zingo-cli --chain testnet --server https://testnet.zec.rocks:443 \
  --data-dir ~/.zshield-testnet/wallet addresses
```

Fund that address with TAZ from a testnet faucet such as https://faucet.testnet.valargroup.dev (API claim) or https://zcashfaucet.jinolabs.xyz and wait for it to confirm. Keep `~/.zshield-testnet/` private; it holds the wallet seed and is never inside the repo. `zingo-cli` creates the wallet with your default umask, which usually leaves it readable by other users, so lock it down:

```bash
chmod 700 ~/.zshield-testnet ~/.zshield-testnet/wallet
chmod 600 ~/.zshield-testnet/wallet/*
```

In testnet mode the server checks this at startup. If the wallet directory is open to group or other users, it prints each path with its mode and the fix, then exits with status 1 instead of serving. A loose file mode inside a private directory only gets a warning, because nobody else can reach that file and `zingo-cli` recreates the wallet file with your umask every time it saves. To keep the file at `600`, the server sets its umask to `077` in testnet mode, which also covers the `zingo-cli` runs it starts and the audit files it writes.

Run the MCP server in testnet mode:

```bash
CHAIN_MODE=testnet ZINGO_BIN=$(which zingo-cli) \
ZINGO_DATA_DIR=~/.zshield-testnet/wallet \
ALLOWLIST_PATH=./allowlists/testnet.json npm start
```

Optional variables: `ZINGO_BIN`, `ZINGO_DATA_DIR`, `LIGHTWALLETD_URL`, and `ZINGO_READ_TIMEOUT_MS` (default `120000`), which stops a read-only call that takes too long.

Run the demo:

```bash
npm run demo:testnet
```

The demo creates a second fresh testnet wallet as the recipient, writes a one-entry allow-list for it, and sends 0.001 TAZ through `executePay`, the same policy path the `zcash_pay` tool uses. It prints the txid and a link on https://blockexplorer.one/zcash/testnet. A confirmed txid proves the full path works end to end: policy checks, audit write, and a real shielded transaction on the Zcash testnet.

## Proof: live testnet payment

One real shielded 0.001 TAZ payment through `zcash_pay`, plus a blocked over-cap attempt: [tx 59d9cb1b5a47... on blockexplorer.one](https://blockexplorer.one/zcash/testnet/tx/59d9cb1b5a473a84602c4812a7809217f6e9d359174deb178e7fd52c151ae8fc)

![Live testnet demo](docs/images/testnet-demo.gif)

## Status and non-goals

- ✅ Mock payments, policy enforcement, audit
- ✅ Testnet shielded sends via zingo-cli
- ✅ Read-only balance, receive address, and history tools
- ✅ Stable rejection codes
- ❌ Daily or rolling spend limits (per call only for now)
- ✅ Audit fingerprint from the wallet's real viewing key (UFVK)
- ❌ Mainnet (refused by design)
- ❌ Custody of user spend keys

## License

MIT
