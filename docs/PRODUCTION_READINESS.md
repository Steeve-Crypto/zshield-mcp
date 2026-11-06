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


## 2026-11-06 root-cause checkpoint

Status: NOT production ready. No change in this checkpoint has been pushed or submitted for independent review. See [per-finding evidence](../V12-RUN14-RESPONSE.md) and [incident runbook](INCIDENT_RUNBOOK.md).

| Risk | Area | Evidence / remaining work |
| --- | --- | --- |
| Critical release gate | Native payment lifecycle | Fake CLI crash and concurrency tests exist. Native funded scratch-wallet exact-txid continuation, calculated-tx persistence, auto-broadcast behavior and host power-loss tests remain required. No real payments were made. |
| High, OPEN | Audit disk isolation, F-82 | Active regression demonstrates caller-controlled refusals consume payment-promised disk. Logical pools are not physical reservations. Implement preallocated payment journal extents or reviewed isolated capacity and crash-safe migration. |
| High, locally fixed | Send/resume consistency | Shared eligibility and wallet-wide gate now apply at resume admission and inside execution fence. Never-authorized tracked calls cannot revive. Legacy pending one-step crash windows block replacement. |
| High, locally fixed | Binding durability | Directory fsync failures propagate without deleting the published name. No-send proof permits identical-key retry under lock. Test proves zero sends before durable binding. |
| High, remaining | State corruption | Orphan pending markers block. Full persisted-record schema validation is not implemented; malformed JSON or truncated/mismatched event records need fail-closed tests and repair procedures. |
| Medium, locally fixed | Refusal evidence and decision privacy | Non-durable ordinary and non-attempted resume refusals return generic audit failure. Previously uncertain payment identity is retained. |
| Medium, partial | Startup/readiness | Fail-fast configuration, local filesystem and financial-profile checks already exist. MCP starts before background recovery completes; there is no dedicated readiness gate for completion. |
| Medium, remaining | Graceful shutdown | No explicit SIGTERM/SIGINT drain. Crash recovery is a fallback, not a bounded drain contract. Define admission closure, in-flight completion, backend lifetime and supervisor deadlines before implementation. |
| Medium, partial | Operations | Operator health, pause, cumulative allowance, signed approvals and snapshot controls exist. Health now reports usable audit slots. Logs are redacted but not consistently structured JSON. Pager and backup encryption are deployment responsibilities. |
| Medium, partial | Security | Tool schemas and bounds, rate limits, private paths, redaction and pinned backend exist. npm audit: zero known advisories this checkpoint. No penetration test or new trust-boundary certification. |
| Medium, locally added | CI and complete tests | Recursive test discovery includes run 13 and all new regressions. CI installs, typechecks, builds, audits and runs coverage. GitHub CI itself has not run. No lint script is currently defined. |
| Required release gate | Independent review | Submit the complete final, green change for independent review only after unresolved blockers are fixed. No V12 trigger or request was made. |

### Production release checklist

- [ ] Close F-82 with physical-space and concurrency evidence, not only statfs thresholds.
- [ ] All recursively discovered tests, typecheck, build and dependency audit green on the final tree and supported deployment Node version.
- [ ] Native testnet qualification with a disposable funded wallet, approved by the operator; capture exact txids and crash/recovery observations.
- [ ] Validate calculated transactions cannot auto-broadcast outside authorization; document exclusive wallet ownership.
- [ ] Qualify filesystem durability, quotas, locks, low inode space and power-loss behavior on deployment storage.
- [ ] Fail closed on corrupt persisted records and rehearse reviewed recovery without deleting keys or pending markers.
- [ ] Define and test readiness and bounded shutdown behavior with surviving backend processes.
- [ ] Rehearse pause, backup, restore, storage exhaustion and reviewed unpause using the incident runbook.
- [ ] Independent security review of the final commit, followed by owner merge and deployment decision.

Final local verification for this checkpoint: pristine base 596/596 tests passed; changed branch 609/610 tests passed, with only the intentionally active F-82 regression failing. Typecheck, build and npm audit passed. No push or PR is permitted from this checkpoint. The coverage report is in `/workspace/zshield-final-rerun.log` on the box. The 68-point crash sweep establishes no duplicate sends, but 17 preauthorization points cleanly refuse continuation rather than complete the payment. Native testnet remains disabled.
