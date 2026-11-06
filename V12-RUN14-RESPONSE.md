# V12 run 14 response: local checkpoint

Base: `4a2fff132201f4a1110dc6930d3d9453d0cf3ff3` on `origin/main`.
Branch: `fix/root-causes`. Nothing pushed. No PR, comment, reviewer request or network payment.

This is NOT a production approval. F-82 remains reproducible and intentionally has an active failing regression. The local branch must not be pushed as an all-green fix.

## Findings

| Finding | Classification on base | Local outcome and evidence |
| --- | --- | --- |
| F-37 | STALE literal key-burn report; CONFIRMED related durability regression | Base `src/fsafe.ts:222-228` swallowed directory fsync errors, while `src/tools/pay.ts:896-918` already recorded `key_binding_failed` and `src/payments/store.ts:275-287` already supported safe failed-binding release. Swallowing the error let a payment use an undurable binding. Fixed in `cbb4d80`. `binding-durability.test.ts`: "F-37 published but unsynced binding never permits send and same key retries safely" failed before and passes after. The authoritative file is retained, no send occurs, and same-key retry is permitted only with durable no-send proof under the wallet lock. |
| F-41 | THREAT-MODEL, native qualification outstanding | Application-only rule: a tracked staged transaction without authorization may be treated as not_sent only if nothing else can broadcast it. Test "F-41 a tracked staged not_sent call cannot be revived by explicit resume" passes. Legacy staged not_sent migration remains covered by v12r13 tests. Native backend persistence, automatic rebroadcast and manual operator transmission are NOT established by fake adapters. F-84's fix closes the application revival path, but this does not prove the native-wallet assumption. Keep native qualification a release gate. |
| F-59 | STALE | Base `src/payments/resume.ts:83-105` validates durable fee, spending and fee reservations before financial audit inside the execution fence. Tests: v12r13 "F-59 refused resumes never consume payment audit capacity" and run14 "F-59 durable fee mismatch never charges payment audit capacity". Repeated mismatches cause zero transmit attempts and no payment-counter growth. |
| F-75 | CONFIRMED | Ordinary pre-intent policy refusals ignored final audit durability, and non-attempted resume results also ignored it. Fixed in `c864dbe` and `afec9fb`. `audit-contract.test.ts`: "F-75 ordinary rejected payments fail closed when refusal audit is unavailable". `v12r14.test.ts`: "F-75 refused resume hides unaudited decision but preserves original uncertainty". Both failed before their fixes. Return AUDIT_WRITE_FAILED, without hiding a potentially earlier payment. |
| F-80 | STALE for legacy unknown with no txid | Base `src/payments/store.ts:178-184,338-344` already passes v12r13 "F-80 a legacy one-step unknown with no txid blocks new live sends". Run 14's F-86 explicitly relies on this supported shape, contradicting F-80's description. Additional self-review found legacy PENDING intents with no result still bypassed the predicate. `d7bd1f2` conservatively blocks those crash windows and orphan pending markers. Test "legacy one-step intent without outcome blocks replacement after crash" failed before, passes after. |
| F-82 | CONFIRMED, OPEN RELEASE BLOCKER | `audit-disk-reserve.test.ts`: "F-82 refusal rows cannot use disk still promised to payment rows" fails on base and remains failing locally. Pool counters do not allocate physical blocks. Refusal logging can consume payment disk. A statfs threshold alone races concurrent writers and is not represented as a complete fix. See the structural design needed below. |
| F-83 | CONFIRMED | `b0bd6ba` makes health report whole usable slots, matching enforcement. `audit-capacity-health.test.ts`: "F-83 health reports usable slots rather than stranded remainder" failed before and passes after. |
| F-84 | CONFIRMED | `34dcba4` shares the existing mayHaveBroadcast contract with resume eligibility. A tracked never-authorized staged transaction cannot first permit a replacement and later revive through explicit resume. Test "F-84 a tracked call never authorized to transmit cannot be revived by explicit resume" failed before, passes after. |
| F-85 | CONFIRMED | `c864dbe` replaces the returned audit object as well as the top-level code with a generic storage failure. The original code, error and refused_code no longer escape. Test "F-85 unaudited key decisions are absent from response and returned audit" failed before and passes after. |
| F-86 | CONFIRMED | `34dcba4` checks other unresolved sends before resume and inside its backend execution fence, with the wallet lock held. Tests "F-86 explicit resume honors the wallet-wide unresolved-send interlock" and "F-86 automatic recovery resume honors the same interlock" failed before, pass after. Positive control "F-86 resume still works once no other send is unresolved" stays passing. |

## Structural causes and fixes

1. Payment identity had incompatible rules across ordinary sends, explicit resume, startup recovery and legacy migration. A local non-transmission proof must both release the replacement interlock and permanently prevent revival. Resume now uses the same broadcast predicate and checks the wallet-wide gate again at execution. Legacy one-step intents without a result are uncertain, not proven never sent.
2. Publication was confused with durability. Returning success after directory fsync fails can lose the binding on a power cut after a real payment. Exclusive creation now retains publication but propagates durability failure. Existing explicit no-send binding recovery is used instead of optimistic sending or unsafe rollback.
3. Decision exposure was not tied to durable refusal evidence. Ordinary refusals and non-attempted resume results now fail closed with a generic result. A prior uncertain payment is still described as uncertain, never as disproven.
4. Health and enforcement used different units. Health now floors to usable reservations.
5. Audit pools isolate logical counters, not physical storage. This root cause is still OPEN.

### Required F-82 design

Use payment-only preallocated journal extents or genuinely isolated capacity with enforceable quotas. Payment evidence must be written INTO its reserved extents, not into a different append file after freeing a spare reserve file. Allocation, slot ownership, crash recovery, rotation and migration must be serialized across processes and fail closed. Both primary and fallback, including shared-filesystem configurations, need explicit guarantees. Test ENOSPC, inodes, quotas, unsupported allocation, two processes, concurrent refusal floods, interrupted reservations and restart migration. Existing counters must never be reset while writers are live. Do not silently convert statfs monitoring into a storage guarantee.

## What prior rounds missed

- PR #5's run 11 review still reported key burning and staged-finalization ambiguity. Its regression contract did not establish both safety and retryability at the fsync boundary.
- PR #6's review reported resume identity loss, upgrade ambiguity, refusal logging and lock fairness. Fixing each local gate did not establish one end-to-end transition contract for send, resume, recovery and upgrade.
- PR #7's review still reported audit refusal/capacity and legacy-send gaps. Separating logical audit pools did not isolate physical disk; health displayed bytes rather than usable slots. Earlier tests also accepted success after unsynced publication.
- PR #8 added the legacy unknown predicate and moved resume financial audit behind gates, making F-80 and F-59 stale. But explicit resume retained a bypass of the authorization classification, omitted the other-payment interlock, and tests/v12r13.test.ts was absent from npm test. The prior correction solved one path while leaving another contradictory path alive.
- Reviews were requested without a final invariant matrix and complete default test discovery. Local test success is not native-wallet validation or independent approval.

## Verification

Pristine detached baseline, all discovered existing test files: 596 passed, 0 failed. Typecheck and build passed. Native testnet was not enabled.

Current typecheck and build passed. npm audit reports 0 known vulnerabilities. Full recursive coverage rerun: 610 tests, 609 passed, 1 failed. The sole failure is the active F-82 disk-protection regression. All other new and existing cases passed. The first full run also found an obsolete failed-binding shape assertion and a generic-error wording compatibility issue; both were corrected, 40 focused tests passed, and the complete suite was rerun. The binding invariant now requires explicit retryable no-send proof rather than assuming every terminal binding is burned. No financial assertion was disabled. No lint script exists. Node on the box is 24.22.1; proposed CI uses Node 22 and has not run on GitHub.

CI now installs, typechecks, builds, audits dependencies and recursively runs all test files with coverage. Discovery no longer depends on an enumerated package.json list. `test:invariants` remains an optional focused command. The F-82 regression intentionally prevents a misleading green result.

## Self-review and release limits

Checked the changed send/resume boundary for stale records, superseded transactions, wallet concurrency, budget refusals, audit failure before versus after transmit, binding publication and failed outcome writes. Existing exact-txid concurrency and crash sweeps remain part of the full suite. SIGKILL simulation does not prove power-loss persistence. The full payment crash matrix exercised 68 kill points without duplicate sends. Seventeen preauthorization points (40 through 56) ended with zero sends and a clean error rather than successful same-key continuation. The harness permits clean refusals there: this is safety evidence, not a proof of uninterrupted payment liveness. The tracked transaction cannot revive after that local non-send classification. Native-wallet behavior and operational replacement guidance remain release gates.

Further production gaps: native funded scratch-wallet qualification, physical audit-space reservation, incomplete record schema/corruption validation, bounded graceful shutdown, readiness linked to recovery completion, and structured operational logging. These are not certified by this patch. See docs/PRODUCTION_READINESS.md and docs/INCIDENT_RUNBOOK.md. No V12 review has been triggered.

## Research

- OWASP transaction authorization: enforce allowed state transitions and a final execution gate: https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
- Linux allocation guarantees apply to writes within the allocated range, with concurrency caveats for emulated fallocation: https://man7.org/linux/man-pages/man3/posix_fallocate.3.html
- The public Grok Bot/X search found no payment-audit reservation implementation suitable to reuse. Social posts are not security evidence.


Final logs on the box:

- `/workspace/zshield-pristine-baseline.log`: immutable base full suite, 596/596.
- `/workspace/zshield-run14-before.log`: initial independent reproduction, 4 failures out of 5.
- `/workspace/zshield-binding-before.log`: unsynced binding incorrectly allowed payment.
- `/workspace/zshield-audit-before.log`: F-75, F-83 and F-85 failures.
- `/workspace/zshield-legacy-before.log`: legacy pending crash interlock failure.
- `/workspace/zshield-resume-refusal-before.log`: non-durable refused resume exposed its decision.
- `/workspace/zshield-compat-after.log`: 40 focused tests passing after the final corrections.
- `/workspace/zshield-final-rerun.log`: complete final coverage run, 609/610. All-files coverage is 97.21% lines, 88.58% branches, 93.62% functions, including test fixtures and temporary fake CLI programs; these are not source-only or native-network coverage percentages.

Additional compatibility/invariant correction: `136553b` (Verify retryable no-send bindings). New regression evidence and financial review rules are preserved in AGENTS.md so the next round cannot mistake visibility for durable authorization or omit a recovery path.
