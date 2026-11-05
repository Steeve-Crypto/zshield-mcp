# Financial-use release assessment

Assessment date: 2026-11-04. This branch is not approved for real-money production.
Mainnet remains refused by configuration, startup and recipient validation.

## Review changes

Recovery and status require affirmative verification for live wallet entries.
Unrecognized statuses cannot establish broadcast. A calculated transaction cannot
establish current broadcast in status. Where outgoing outputs are provided,
recovery requires exactly the intended output, not just one matching output among
extra payments. Regression cases check both the returned status and continued
blocking of replacement payments.

Production dependency audit initially reported five vulnerable packages. Updated
body-parser, fast-uri, ip-address, qs and Zod; Zod moved to 4.6.7. The lockfile
records exact resolutions. An advisory scan is evidence about known advisories,
not proof that dependencies are vulnerability-free.

## Required release evidence

| Gate | Current limitation / required evidence |
| --- | --- |
| Native wallet and funded testnet | Not run here: no native zingo-cli or configured funded scratch wallet. Run the pinned backend and retain txids, wallet observations and process results. |
| Exact-transaction continuation | Demonstrate persistence after stage, interrupted transmission, same-txid retry and confirmation with the actual backend. Fake subprocess tests cannot establish backend behavior. |
| Independent audit | A fresh V12 review of the final commit has not been run. Prior findings and local tests are not approval of this revision. |
| Deployment filesystem | Validate OS ownership, lock lifetime and durability on the intended filesystem and OS. Simulated UID metadata is not a multi-user deployment test; process SIGKILL is not a host power-loss test. |
| Operational recovery | Coordinated snapshots, digest-checked quarantine restore and operator alerts are implemented. Rehearse them on the actual deployment, use encrypted backup storage, and retain post-snapshot payment evidence. Never reset keys to get past uncertainty. |
| Spending authority | Implemented: durable cumulative principal allowance, Ed25519 approval thresholds and emergency pause. Enable FINANCIAL_CONTROLS_REQUIRED=1; review fee policy and deploy separate signing authorities. |
| Mainnet scope | Unsupported. Enabling it requires a separate design and review; removing the network guard is not a production-readiness fix. |

## Commands

Use `npm ci`, `npm run build`, `npm run typecheck`, `npm test` and `npm audit`.
The ordinary test command includes an opt-in native suite. Node may report zero
skipped test cases even though that suite is disabled; the aggregate count must
not be presented as evidence that native tests ran.

`npm run test:testnet` now fails immediately if its prerequisites are missing,
rather than returning a green result from a skipped suite. Set absolute paths in
`ZSHIELD_TESTNET_ZINGO_BIN` and `ZSHIELD_TESTNET_WALLET`. The wallet must be a funded,
disposable TESTNET scratch copy; this command sends testnet self-payments and
interrupts wallet processes. The suite contains observations as well as assertions;
passing it alone does not close every release gate above.

## Previous review evidence

Clean install, build and typecheck passed. Full suite: 524 passing tests, zero
failures; native suite disabled. Crash sweeps: 62 payment and 26 resume durable
operation points. `npm audit` reported zero known vulnerabilities. The explicit
native command was exercised without prerequisites and correctly exited with a
failure, rather than implying that testnet verification succeeded.


## Implemented operational controls

See [operator controls](OPERATOR_CONTROLS.md) for configuration, trust boundaries,
commands and incident procedures. Each distinct change is committed separately:
payment pause; cumulative principal allowance; signed approvals; coordinated
snapshots; operational alerts; and financial deployment prerequisites. Commit
subjects are limited to five words, recorded in the repository's AGENTS.md.

These additions remain testnet-only. They do not provide external certification,
a fee-inclusive spending cap, automatic rolling resets, off-host backup encryption,
or an externally configured pager. Native-wallet and independent-review evidence
remain outstanding. Do not equate the required-control profile with mainnet approval.

## Operational-control validation

Build and typecheck passed. The full 552-test run passed 551 tests and found one
README coverage failure for the three new refusal codes. After documenting those
codes, all 30 documentation, refusal-code and policy-resource checks passed. No
financial behavior assertion was relaxed. The run passed all 62 original-payment
crash points and all 26 resume crash points. Native testnet remained disabled.

The operator CLI also passed pause, dual-lock snapshot, digest-checked restore and
reviewed-unpause smoke checks using a synthetic wallet, without a network payment.
Individual regression suites cover cross-process cumulative limits, incomplete
reservations, control removal, signature thresholds and expiry, mid-signing
revocation, snapshot tampering and traversal, surviving backend processes, monitoring
privacy, executable replacement and deployment prerequisites.
