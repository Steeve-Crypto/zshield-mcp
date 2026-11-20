# Changelog

Beta software. Do not use with real funds.

## Unreleased

- README, package description and the `zcash_pay` tool description now lead with real testnet payments. The mock chain is described as a tool for local tests and demos.
- Quickstart starts with `npx -y zshield-mcp@beta` and a testnet config.

## 0.2.0-beta.1 (2026-11-15)

Install: `npm install zshield-mcp@beta`

- Two new testnet wallet backends: zkool (`CHAIN_MODE=zkool`) and Ironclad (`CHAIN_MODE=ironclad`, a FROST group wallet with a policy co-signer, contributed by Adil Husain). Both refuse mainnet.
- The lifetime allowance now charges a payment's amount and fee together, once, when the send is authorized. Refused payments charge nothing.
- Spending checks no longer reread the whole payment history, so they stay fast as history grows.
- The payment store adds a `calls/zshield-generation` folder. Older versions refuse to run on it. To downgrade, stop zshield and remove that folder first.
- Stricter send checks: zkool sends must match the planned recipient and change, only unified address receivers are trusted, and resume records are saved before any transmit.
- No known vulnerabilities. 752 tests pass.
- Mainnet stays off unless explicitly configured.

## 0.1.0 testnet beta (2026-11-05)

Tag `v0.1.0-testnet-beta`, at main `6227566`.

- Testnet and mock modes ready to try. Mainnet stays off unless `CHAIN_MODE=mainnet` and `MAINNET_ENABLED=1` are both set, along with an explicit `ZINGO_DATA_DIR`.
- Includes phase 1 hardening, operator controls, the fixes from review runs 11, 12 and 13, and the root cause fixes from PR #9.
- 632 of 632 tests pass.
- Testnet self payment on this commit: `687194b53bdf52f64bd359373c0a666807e0daeef1bb24dd8185157f4db0495e`.
- Known open items from review run 15: 2 High, 2 Medium, 1 Low.
