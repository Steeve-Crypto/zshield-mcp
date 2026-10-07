# zshield-mcp

Open-source **MCP server** that exposes one tool — `zcash_pay` — for agent-initiated **shielded ZEC** payments under human policy:

- **Hard per-call spending cap**
- **Recipient allow-list**
- **Append-only viewing-key fingerprinted audit log**

Spend keys never belong in the model. **Chain is mocked first**; a live light-wallet adapter is stubbed and refused at startup.

## Purpose

Agents need a payment tool they can call safely. This server enforces policy *before* any payment attempt, records an audit row for every call (success or reject), and fingerprints viewing-key material so auditors can correlate receipts without storing raw keys in the log.

Built as a concrete, minimal artifact for design-partner review of shielded agent-payment MCP surfaces (see Zcash Community Grants discussions around agent/MCP payment tooling).

## Quickstart

```bash
git clone <this-repo> zshield-mcp && cd zshield-mcp
cp .env.example .env
npm install
npm test
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
| `amount_zec` | number | yes | Must be `> 0` and `<= SPENDING_CAP_ZEC` |
| `recipient` | string | yes | Must exactly match an allow-list `address` |
| `memo` | string | no | Optional memo (mock) |

Resource `zshield://policy` returns the active cap, allow-list path, and chain mode.

## Config: caps & allow-list

Precedence: **environment variables** override `config/default.yaml`.

| Variable | Default | Meaning |
|----------|---------|---------|
| `SPENDING_CAP_ZEC` | `0.1` | Hard max ZEC **per tool call** |
| `ALLOWLIST_PATH` | `./allowlists/recipients.example.json` | JSON allow-list |
| `CHAIN_MODE` | `mock` | `mock` only for now (`live` exits) |
| `AUDIT_DIR` | `./audits` | JSONL audit directory |
| `VIEW_KEY_FINGERPRINT_SALT` | from yaml | Salt for view-key fingerprints |

Allow-list shape:

```json
{
  "recipients": [
    { "address": "u1…", "label": "Demo merchant" }
  ]
}
```

## Audit log format

JSONL per day: `audits/YYYY-MM-DD.jsonl`. Example success line:

```json
{"ts":"2026-10-05T19:00:00.000Z","tool":"zcash_pay","amount_zec":0.05,"recipient":"u1…","allowlist_hit":true,"cap_zec":0.1,"status":"ok","mock_txid":"mock_…","view_key_fingerprint":"a1b2c3d4e5f60718","memo":"test"}
```

Raw viewing-key material is **never** written — only a short fingerprint. See [docs/AUDIT.md](docs/AUDIT.md).

## Layout

```
src/policy/   caps + allow-list
src/chain/    mock adapter + live stub
src/audit/    JSONL writer + fingerprint
src/tools/    zcash_pay
src/server.ts MCP registration
tests/        happy path + rejections
```

## Status / non-goals

- ✅ Mock payments, policy enforcement, audit
- ❌ Live Zcash chain / wallet wiring (stub only)
- ❌ Custody of user spend keys

## License

MIT
