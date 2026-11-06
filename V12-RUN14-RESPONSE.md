# V12 run 14 response

Base: `4a2fff132201f4a1110dc6930d3d9453d0cf3ff3` on `origin/main`.
Branch: `fix/root-causes`. No merge, reviewer request, V12 trigger or network payment.

This is not financial deployment approval. The code fixes, including F-82, have passed local verification. Native-wallet, actual deployment-storage and independent qualification remain release gates. See the latest verification below.

## Findings

| Finding | Classification on base | Local outcome and evidence |
| --- | --- | --- |
| F-37 | STALE literal key-burn report; CONFIRMED related durability regression | Base `src/fsafe.ts:222-228` swallowed directory fsync errors, while `src/tools/pay.ts:896-918` already recorded `key_binding_failed` and `src/payments/store.ts:275-287` already supported safe failed-binding release. Swallowing the error let a payment use an undurable binding. Fixed in `cbb4d80`. `binding-durability.test.ts`: "F-37 published but unsynced binding never permits send and same key retries safely" failed before and passes after. The authoritative file is retained, no send occurs, and same-key retry is permitted only with durable no-send proof under the wallet lock. |
| F-41 | THREAT-MODEL, native qualification outstanding | Application-only rule: a tracked staged transaction without authorization may be treated as not_sent only if nothing else can broadcast it. Test "F-41 a tracked staged not_sent call cannot be revived by explicit resume" passes. Legacy staged not_sent migration remains covered by v12r13 tests. Native backend persistence, automatic rebroadcast and manual operator transmission are NOT established by fake adapters. F-84's fix closes the application revival path, but this does not prove the native-wallet assumption. Keep native qualification a release gate. |
| F-59 | STALE | Base `src/payments/resume.ts:83-105` validates durable fee, spending and fee reservations before financial audit inside the execution fence. Tests: v12r13 "F-59 refused resumes never consume payment audit capacity" and run14 "F-59 durable fee mismatch never charges payment audit capacity". Repeated mismatches cause zero transmit attempts and no payment-counter growth. |
| F-75 | CONFIRMED | Ordinary pre-intent policy refusals ignored final audit durability, and non-attempted resume results also ignored it. Fixed in `c864dbe` and `afec9fb`. `audit-contract.test.ts`: "F-75 ordinary rejected payments fail closed when refusal audit is unavailable". `v12r14.test.ts`: "F-75 refused resume hides unaudited decision but preserves original uncertainty". Both failed before their fixes. Return AUDIT_WRITE_FAILED, without hiding a potentially earlier payment. |
| F-80 | STALE for legacy unknown with no txid | Base `src/payments/store.ts:178-184,338-344` already passes v12r13 "F-80 a legacy one-step unknown with no txid blocks new live sends". Run 14's F-86 explicitly relies on this supported shape, contradicting F-80's description. Additional self-review found legacy PENDING intents with no result still bypassed the predicate. `d7bd1f2` conservatively blocks those crash windows and orphan pending markers. Test "legacy one-step intent without outcome blocks replacement after crash" failed before, passes after. |
| F-82 | CONFIRMED, FIXED | `529b186` preallocates actual zero-filled blocks and fsyncs the complete journal before exclusive publication. Payment evidence is written in place under a cross-process flock using incomplete and committed slot markers. Refusal/diagnostic rows never enter the reserved segment. Existing "F-82 refusal rows cannot use disk still promised to payment rows" now verifies allocated blocks, fixed size/block count and successful reserved writes while traffic appends return ENOSPC. Seven additional physical-reservation tests cover exhaustion, restart, SIGKILL during allocation, ENOSPC during allocation, interrupted slots, process concurrency and legacy charges. See [journal design and operator procedure](docs/PAYMENT_AUDIT_JOURNAL.md). |
| F-83 | CONFIRMED | `b0bd6ba` makes health report whole usable slots, matching enforcement. `audit-capacity-health.test.ts`: "F-83 health reports usable slots rather than stranded remainder" failed before and passes after. |
| F-84 | CONFIRMED | `34dcba4` shares the existing mayHaveBroadcast contract with resume eligibility. A tracked never-authorized staged transaction cannot first permit a replacement and later revive through explicit resume. Test "F-84 a tracked call never authorized to transmit cannot be revived by explicit resume" failed before, passes after. |
| F-85 | CONFIRMED | `c864dbe` replaces the returned audit object as well as the top-level code with a generic storage failure. The original code, error and refused_code no longer escape. Test "F-85 unaudited key decisions are absent from response and returned audit" failed before and passes after. |
| F-86 | CONFIRMED | `34dcba4` checks other unresolved sends before resume and inside its backend execution fence, with the wallet lock held. Tests "F-86 explicit resume honors the wallet-wide unresolved-send interlock" and "F-86 automatic recovery resume honors the same interlock" failed before, pass after. Positive control "F-86 resume still works once no other send is unresolved" stays passing. |

## Structural causes and fixes

1. Payment identity had incompatible rules across ordinary sends, explicit resume, startup recovery and legacy migration. A local non-transmission proof must both release the replacement interlock and permanently prevent revival. Resume now uses the same broadcast predicate and checks the wallet-wide gate again at execution. Legacy one-step intents without a result are uncertain, not proven never sent.
2. Publication was confused with durability. Returning success after directory fsync fails can lose the binding on a power cut after a real payment. Exclusive creation now retains publication but propagates durability failure. Existing explicit no-send binding recovery is used instead of optimistic sending or unsafe rollback.
3. Decision exposure was not tied to durable refusal evidence. Ordinary refusals and non-attempted resume results now fail closed with a generic result. A prior uncertain payment is still described as uncertain, never as disproven.
4. Health and enforcement used different units. Health now floors to usable reservations.
5. Audit pools isolated logical counters, not physical storage. Fixed by independent, physically allocated journals for primary and fallback. Compatibility JSONL failure cannot negate committed payment evidence.
6. Persisted record parsing silently ignored malformed JSON, unknown states and truncated event histories. `c76f49a` validates intent, event, binding, metadata, tip and index shapes, rejects unknown fields/versions and refuses missing/mismatched identities. `5379441` verifies restart cannot redirect a corrupt store into fresh fallback state. All six original schema tests failed before this fix and pass afterward; a seventh covers restart.
7. Self-review found pre-intent infrastructure errors still used protected audit slots. `f377962` classifies those as refusal traffic while retaining tx-bearing and legacy unknown evidence in the payment pool. A repeated backend-error regression failed before the fix and passes after it.

### Implemented F-82 storage contract

The primary and fallback canonical `.budget` directories each contain a fixed-slot `payment-evidence.bin`. Real blocks are written in bounded chunks and fsynced before an exclusive final name is published. A crash cannot publish a partially initialized reservation. Writers flock the inherited journal inode, fsync an incomplete marker, write and fsync length/checksum/JSON, then fsync the committed marker before acknowledging durability. An interrupted slot remains consumed; no lease or restart reclaims it. No financial append grows the file.

Refusal and diagnostic logging uses the separate bounded traffic files. Payment JSONL rows are best-effort mirrors, not the protected evidence source. Both reservations are attempted before traffic; startup fails if neither is usable. Existing baseline bytes and old payment counters remain charged without creating fresh payment-counter metadata during a reserved write. Operator health counts complete and incomplete slots.

Only qualified Linux ext4 and XFS are supported for these reservations. Mixed-version writers, live reflinks, deduplication and compression are unsupported. Increasing capacity requires offline reviewed migration, not truncation or replacement of evidence. Both `.budget` directories are already included by coordinated snapshots. Export complete rows with `npm run audit:payments -- /absolute/path/payment-evidence.bin` and keep the output private.

Tests verify real block allocation plus injected ENOSPC for traffic writes. They do not destructively fill a deployed volume or establish host power-loss behavior. Actual deployment storage still requires qualification.

## What prior rounds missed

- PR #5's run 11 review still reported key burning and staged-finalization ambiguity. Its regression contract did not establish both safety and retryability at the fsync boundary.
- PR #6's review reported resume identity loss, upgrade ambiguity, refusal logging and lock fairness. Fixing each local gate did not establish one end-to-end transition contract for send, resume, recovery and upgrade.
- PR #7's review still reported audit refusal/capacity and legacy-send gaps. Separating logical audit pools did not isolate physical disk; health displayed bytes rather than usable slots. Earlier tests also accepted success after unsynced publication.
- PR #8 added the legacy unknown predicate and moved resume financial audit behind gates, making F-80 and F-59 stale. But explicit resume retained a bypass of the authorization classification, omitted the other-payment interlock, and tests/v12r13.test.ts was absent from npm test. The prior correction solved one path while leaving another contradictory path alive.
- Reviews were requested without a final invariant matrix and complete default test discovery. Local test success is not native-wallet validation or independent approval.

## Verification

Immutable clean base: typecheck and build passed; 596/596 recursively discovered tests passed. The first local checkpoint had 609/610 with F-82 still failing. No failure was disabled or skipped to obtain the final result.

After physical reservations and strict record validation, Node 24.22.1 passed all 623 tests. Self-review then added preauthorization isolation and corrupt-store restart coverage. Node 22.23.4, matching the CI major version, passed the expanded 625-test suite with coverage. The final rerun after bounding test-only allocation sizes also passed: 625 tests across 143 suites, zero failures, cancellations or skipped cases, in 214.84 seconds on Node 22.23.4. Coverage across all files was 97.85% lines, 90.47% branches and 94.19% functions, including tests and fake CLI fixtures. Production default capacity remains 64 MiB per destination and has an explicit configuration assertion. Real default reservations consume about 192 MiB in total; test fixtures use smaller actual allocations, not sparse mocks.

Typecheck, build and npm audit passed; npm audit reported zero known vulnerabilities. No lint script exists. Native testnet was not enabled. CI installs, typechecks, builds, audits dependencies and recursively runs every test file with coverage on Node 22. Branch push plus PR creation no longer launches duplicate CI runs: branch verification is on PRs, with main pushes also verified.

## Self-review and limits

Reviewed crash and fsync boundaries, concurrent slot ownership, canonical path aliases, old-counter migration, exhausted journals, failed compatibility mirrors, interrupted initialization, stale/superseded resume, missing authorization, budget refusals, malformed persisted records and restart fallback. Positive controls still resume exactly the original authorized txid. Existing process crash and concurrent-payment suites remain enabled.

The final original-payment sweep exercised 83 durable kill points with no duplicate sends: 66 continued to mined, while 17 preauthorization points cleanly refused continuation with CHAIN_ERROR and zero sends. That is safety evidence, not uninterrupted-liveness proof. Process SIGKILL is not a host power-loss test. No real Zcash transaction, native-wallet qualification, deployment or independent security review was performed.

Remaining work, ranked by risk: native backend calculated-tx and rebroadcast qualification; actual storage exhaustion/power-loss and mixed-version migration rehearsal; independent review of the final commit; bounded graceful shutdown; recovery-aware readiness and consistently structured operational logs. Strict record schemas deliberately stop on unknown legacy shapes or future fields. Inventory and review actual deployment records before upgrade; do not repair them by deleting keys or markers.

See [production scorecard](docs/PRODUCTION_READINESS.md), [journal contract](docs/PAYMENT_AUDIT_JOURNAL.md) and [incident runbook](docs/INCIDENT_RUNBOOK.md).

## Research

- OWASP final execution gates and allowed state transitions: https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
- Allocation guarantees apply to writes within the allocated range, not to a separate append file after freeing a spare reserve: https://man7.org/linux/man-pages/man3/posix_fallocate.3.html

## Logs on the box

- `/workspace/zshield-pristine-baseline.log`: immutable clean baseline, 596/596.
- `/workspace/zshield-final-rerun.log`: initial held checkpoint, 609/610, F-82 open.
- `/workspace/zshield-reservation-focused.log`: physical reservation regressions.
- `/workspace/zshield-schema-before.log`: six schema regressions failing before validation.
- `/workspace/zshield-preintent-before.log`: protected-slot drain from preauthorization errors.
- `/workspace/zshield-final-physical-schema.log`: Node 24, 623/623.
- `/workspace/zshield-node22-final.log`: Node 22 expanded suite.
- `/workspace/zshield-node22-release.log`: final CI-matching rerun and coverage after test-resource controls.

All-files coverage includes test fixtures and temporary fake CLI programs. Do not present it as source-only or native-network coverage.
