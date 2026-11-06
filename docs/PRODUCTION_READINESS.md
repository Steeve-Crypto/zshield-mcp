# Financial-use release assessment

Assessment date: 2026-11-05. Mainnet implementation is opt-in and requires financial controls.
Native wallet and final-review evidence are still pending.

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
| Spending authority | Implemented: durable cumulative principal and fee allowance, Ed25519 approval thresholds and emergency pause. Enable FINANCIAL_CONTROLS_REQUIRED=1; review fee policy and deploy separate signing authorities. |
| Mainnet scope | Implemented: explicit opt-in, mandatory controls, network-bound wallet state, approvals and intents, and affirmative wallet/server checks. No mainnet payment was run here. |

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
payment pause; cumulative principal and fee allowance; signed approvals; coordinated
snapshots; operational alerts; and financial deployment prerequisites. Commit
subjects are limited to five words, recorded in the repository's AGENTS.md.

The native harness remains testnet-only. These additions do not provide external certification,
automatic rolling resets, off-host backup encryption,
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

## Fee and mainnet validation

On 2026-11-05, build and typecheck passed and the complete local suite passed all
565 tests with zero failures. Coverage includes fee-cap exhaustion before funds
move, malformed fee reports, crash-safe fee receipts, legacy ledger refusal,
original-fee verification on resume, cross-network approvals and recovery,
mainnet CLI arguments, server and wallet mismatches, and wallet network binding.
The final HTTPS prerequisite checks also passed all eight mainnet/deployment tests.
The native-wallet suite remained disabled; no real network payment was performed.

The first full run caught three error-message/check-order regressions. The checks
were corrected, targeted tests passed, and the complete suite was rerun successfully.
The distributable patch was applied to the reviewed base in a disposable checkout
and its resulting tree was compared with the committed source tree.


## 2026-11-06 root-cause review

Code fixes have passed local verification. Financial deployment is not approved without the remaining native, storage and independent qualification. See [per-finding evidence](../V12-RUN14-RESPONSE.md), [physical audit contract](PAYMENT_AUDIT_JOURNAL.md) and [incident runbook](INCIDENT_RUNBOOK.md).

| Risk / status | Area | Evidence / remaining work |
| --- | --- | --- |
| Critical release gate | Native payment lifecycle | Fake subprocess crash and concurrency tests pass. Qualify the actual pinned wallet's calculated-tx persistence, exact-txid continuation, automatic broadcast behavior and recovery on a funded disposable testnet wallet. No native or real-network payment was performed here. |
| High release gate | Deployment storage and rollout | Real zero-filled, fsynced extents protect payment evidence. Allocation failure, injected traffic ENOSPC, SIGKILL initialization, restart, incomplete slots, migration charges and cross-process ownership pass locally. Rehearse actual volume exhaustion, inodes, quotas, host power loss and offline upgrade on deployment storage. Never mix old and new writers or reflink/deduplicate/compress live journals. |
| Required release gate | Independent review | Review the final commit independently before owner merge and deployment approval. No V12 trigger or review request was sent. |
| High, locally fixed | Send/resume consistency | Shared eligibility and wallet-wide gates apply before resume and inside the execution fence. Never-authorized tracked calls cannot revive. Legacy pending one-step crash windows and orphan markers block replacement. |
| High, locally fixed | Binding durability | Directory fsync failures propagate without deleting publication. Identical-key retry requires explicit durable no-send proof under the wallet lock. |
| High, locally fixed | Physical audit isolation, F-82 | Payment evidence goes into preallocated fixed slots, not a growing JSONL file. Refusal and diagnostic traffic cannot consume those slots. JSONL mirrors are best effort; a failed mirror does not discard a committed payment record. |
| High, locally fixed | Persisted-state integrity | Strict schemas reject malformed JSON, unknown fields/versions/states, type errors, mismatched identities and over-limit event histories. Restart cannot silently redirect corrupt state into a fresh store. Review real legacy records before rollout; unknown shapes intentionally fail closed. |
| Medium, locally fixed | Refusal evidence/privacy | Non-durable ordinary and resume refusals return generic audit failure while preserving earlier uncertainty. Preauthorization infrastructure errors no longer charge protected payment evidence. |
| Medium, remaining | Shutdown/readiness/logs | No explicit bounded SIGTERM/SIGINT drain or readiness gate tied to background recovery completion. Operational logs are redacted but not consistently structured JSON. Crash recovery is not graceful drain. |
| Medium, deployment responsibility | Operations | Pause, cumulative principal-plus-fee allowance, signed approvals, coordinated snapshots and operator health exist. Rehearse private journal export, encrypted off-host backup, pager routing, restore and reviewed unpause. |
| Locally verified | Tests and CI | Recursive discovery, typecheck, build, npm audit and coverage run on Node 22. No lint script exists. GitHub CI will verify the PR; local success is not a claim that remote checks have completed. |

### Release checklist

- [x] Fix F-82 using real allocated payment extents, with exhaustion, crash, restart and concurrency regressions.
- [x] Reject corrupt or unknown persisted payment records instead of silently ignoring them.
- [x] Preserve complete default test discovery, typecheck, build, dependency audit and coverage gates.
- [ ] Native testnet qualification and explicit operator approval for any funded tests.
- [ ] Qualify deployed storage guarantees, actual full-volume behavior and offline migration.
- [ ] Review actual legacy records against the strict schemas without deleting financial identity.
- [ ] Define and test recovery-aware readiness and bounded shutdown with surviving backend processes.
- [ ] Rehearse backups, audit-journal export, storage incidents and reviewed unpause.
- [ ] Independent review of the final commit, followed by owner merge and deployment decision.

The clean base passed 596 tests. Node 24 passed all 623 tests after the first physical/schema fixes, and the expanded Node 22 suite passed 625 tests. The final CI-matching Node 22 rerun after bounded test allocations also passed all 625 tests across 143 suites, with zero failures. Typecheck, build and dependency audit passed; there were zero known advisories. The 83-point original-payment crash sweep had no duplicate sends, with 17 safe preauthorization refusals rather than completion. Full evidence is in V12-RUN14-RESPONSE.md. Native tests remain disabled; no mainnet or testnet transaction was submitted.
