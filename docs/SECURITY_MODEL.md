# Security model

This document describes what zshield-mcp protects, what it trusts, and where it falls short today. It covers the code as it is in this repository. If the code and this document disagree, the code wins and this document has a bug.

## Summary

zshield-mcp lets an AI agent ask for shielded ZEC payments without ever holding a key. The agent can only call MCP tools. The server checks every payment against a per-call cap, an allow-list, and the network, writes an audit row, and only then asks `zingo-cli` to send. Mainnet is refused at several layers. The live adapter runs on Zcash testnet only, and the default is a mock chain that moves nothing.

It is a policy gate for a single local operator. It is not a custody system, it does not authenticate anyone, and it does not limit total spending over time.

## Where keys live

- **Mock mode.** There are no keys. The mock wallet is an in-memory ledger that starts at 10 ZEC and resets when the server restarts.
- **Testnet mode.** The wallet seed and spending keys live in the `zingo-cli` wallet file, by default `~/.zshield-testnet/wallet/zingo-wallet.dat`. `zingo-cli` creates and manages that file. zshield-mcp never reads it, never parses it, and never passes a seed, spending key, or viewing key to the agent or into the audit log.
- **The agent and the model.** They hold no keys. They see only tool results: txids, amounts, balances, the wallet's receive address, and transaction summaries.
- **The fingerprint salt.** `VIEW_KEY_FINGERPRINT_SALT` comes from the environment or `config/default.yaml`. The default value is `dev-only-change-me`. It is never returned by any tool or by the policy resource.

Limits today:

- zshield-mcp does not encrypt the wallet file and does not check its permissions. Anyone who can read that file as the server's OS user, or as root, can take the testnet funds. Keep `~/.zshield-testnet` readable only by you (`chmod -R go-rwx ~/.zshield-testnet`).
- The server process runs as the same OS user as the wallet. A bug or compromise in the server process, its npm dependencies, or `zingo-cli` can reach the keys. Nothing in this design isolates them.

## What the server can do

- Send ZEC from the configured wallet to an address on the allow-list, up to `SPENDING_CAP_ZEC` per call, on testnet only. In mock mode it only updates the mock ledger.
- Read the wallet's balance, current unified address, and recent transactions through `zcash_balance`, `zcash_receive_address`, and `zcash_history`.
- Read the allow-list file on every `zcash_pay` call and every read of `zshield://policy`.
- Append rows to JSONL files in `AUDIT_DIR`.
- Run `zingo-cli` as a child process with a fixed argument list. It uses `execFile`, so no shell parses the arguments.

## What the server cannot do

- Pay an address that is not an exact match for an allow-list entry.
- Pay more than the cap in one call. Amounts and the cap are compared as integer zatoshis, so there is no float rounding to slip past the cap.
- Pay on mainnet. See "Mainnet refusal" below.
- Change its own policy. No tool writes the allow-list, the cap, the mode, or the audit settings.
- Export the seed or a viewing key. No code path calls `zingo-cli recovery_info`, `export_ufvk`, or similar commands.
- Run arbitrary `zingo-cli` commands on behalf of the agent. The tools map to a fixed set of commands: `quicksend`, `balance`, `spendable_balance`, `addresses`, and `transactions`.

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

- Every tool call that reaches the server's handler writes at least one JSONL row. A call whose arguments have the wrong JSON type, such as a boolean `amount_zec`, is refused by the MCP SDK's schema check before the handler runs, so it gets an error but no audit row. A payment that passes policy writes a `pending` row before the send and a result row after it, linked by `call_id`. If the `pending` row cannot be written, nothing is sent and the call fails with `AUDIT_WRITE_FAILED`.
- If the result row cannot be written after a send, the tool still returns the txid with an `audit_warning`. Throwing there would hide a real payment and invite a retry that pays twice. The `pending` row remains as the record.
- Rejected and failed calls record a stable `code`, such as `CAP_EXCEEDED` or `NOT_ALLOWLISTED`.
- Read-only tool rows hold no balances, addresses, or transaction details.

Limits today:

- "Append-only" is a convention, not an enforcement. The files are plain JSONL. Anyone who can write to `AUDIT_DIR` can edit or delete rows, and nothing would detect it. There is no hash chain, signature, or remote copy.
- Payment rows store the recipient address, the amount, and the memo in plaintext. Treat the audit directory as sensitive.

## The viewing-key fingerprint

Each payment row has a `view_key_fingerprint`. Despite the name, **it is not derived from a real viewing key** in either mode:

- In mock mode the "viewing-key material" is a hash of the mock txid and the recipient.
- In testnet mode it is also `sha256(txid | recipient)`, built in `src/chain/live.ts`. It never touches the wallet's actual unified full viewing key.
- The logged value is the first 16 hex characters of `sha256(salt | material)`.
- Rejected, failed, and `pending` rows use a fixed fingerprint of the word `none`, so those rows all share one value under a given salt.

So today the fingerprint works as a salted tag for each transaction. It does not let an auditor prove anything about the wallet's keys, and it adds little beyond the txid that the same row already stores. A real design would fingerprint the wallet's UFVK once and record it on every row, so an auditor holding the UFVK could match the log to the chain. That is not built yet.

## Threats and mitigations

| Threat | Mitigation | What is left |
|--------|------------|--------------|
| Prompt injection makes the agent pay an attacker | Recipient must be on the allow-list, an exact string match | An attacker can still steer payments to any allow-listed address |
| Agent pays too much in one go | Hard per-call cap, compared in integer zatoshis | None for a single call |
| Agent drains the wallet with many small payments | None in the server | There is no daily or rolling cap, no rate limit, and no human approval step. Total loss is bounded only by the wallet balance. Fund the wallet with only what you can lose |
| Concurrent calls race each other | Each call is checked on its own | Concurrent calls can each pass the per-call cap. There is no shared budget to race |
| Float rounding slips past the cap | Amounts parsed as decimal strings into integer zatoshis; more than 8 decimals is rejected, not rounded | None known |
| Payment lands on mainnet | Seven layers listed under "Mainnet refusal" | Prefix checks only, no checksum decode |
| Payment with no audit trail | `pending` row is written before the send; the send is refused if that write fails | Rows can be edited afterwards by anyone with file access |
| Retry after a timeout pays twice | Post-send audit failures return the txid instead of throwing. `CHAIN_ERROR` is documented as "check history before retrying" | A `zingo-cli` timeout can hide a send that did go out. There is no idempotency key |
| Memo leaks data | Memo is capped at 512 characters | The agent chooses the memo text. Anything in it reaches an allow-listed recipient and the audit log. Memos also appear briefly in the local process list as a `zingo-cli` argument |
| Key theft from disk | Keys stay in the `zingo-cli` wallet file, outside the repo | The file is not encrypted by zshield-mcp and its permissions are not checked |
| Lying or stale lightwalletd | None in the server | Balances and history are only as good as the server `zingo-cli` talks to |
| Hostile allow-list or config edit | None in the server | Whoever can write those files sets policy. The allow-list is re-read on every call, so an edit takes effect at once |
| Slow or stuck `zingo-cli` | Read tools time out after `ZINGO_READ_TIMEOUT_MS`, default 120 seconds. Sends time out after 15 minutes | A stuck send blocks that tool call until the timeout |

## Out of scope

- Mainnet and real funds.
- Custody of anyone else's keys, or more than one wallet.
- Multiple users, authentication, or remote access to the MCP server.
- A compromised host, OS user, Node.js runtime, npm dependency, or `zingo-cli` binary.
- Network privacy. Connections to lightwalletd reveal your IP address. There is no Tor or mixnet support in zshield-mcp.
- The correctness of `zingo-cli`, lightwalletd, and the Zcash protocol.
- Denial of service against the server or the wallet.
- Legal and compliance retention of the audit log.

## Where to look in the code

- Policy checks: `src/policy/caps.ts`, `src/policy/amount.ts`, `src/policy/allowlist.ts`
- Payment flow and audit ordering: `src/tools/pay.ts`
- Read-only tools: `src/tools/read.ts`, `src/tools/balance.ts`, `src/tools/address.ts`, `src/tools/history.ts`
- Network checks: `src/chain/network.ts`
- Testnet adapter and fingerprint material: `src/chain/live.ts`
- Startup refusal of mainnet: `src/config.ts`, `src/index.ts`
- Stable codes: `src/errors.ts`
