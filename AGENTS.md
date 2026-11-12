# Project working rules

- Make a separate commit for each distinct fix.
- Every commit subject must contain no more than five words.
- Use concrete descriptive subjects and titles. Do not use phase labels.
- Preserve payment identity and fail closed on uncertain financial outcomes.
- Add meaningful regression coverage for financial behavior changes.
- Report native-network and independent-review gaps honestly; passing local tests is not release approval.

## Financial review invariants

- Reproduce each review finding against an immutable base. Distinguish stale reports from confirmed defects before changing payment behavior.
- A lifecycle-gate change needs coverage across ordinary send, explicit resume, startup recovery and legacy migration, including crash and concurrent-call boundaries.
- A local proof that permits a replacement payment must permanently forbid revival of the old tracked transaction. Missing outcomes are uncertainty, not proof of non-payment.
- Never suppress an fsync failure to make publication look durable. Keep authoritative publication and require explicit durable no-send proof before a failed binding can be retried under the wallet lock.
- Logical audit pools and statfs thresholds are not physical disk reservations. Do not claim guaranteed evidence capacity without qualifying the storage mechanism and concurrent writers.
- Run npm test or npm run test:coverage for recursive discovery, plus typecheck and build. Do not disable a failing financial regression to obtain a green release.
- Preserve already accepted payment identity in error responses. Failure to log a result cannot undo a transmission or authorize a replacement key.

- Payment evidence now lives in fixed, physically allocated journals. JSONL rows may be absent compatibility mirrors; use the private journal export before concluding that evidence is missing.
- Never reset, reflink, deduplicate, compress or replace live reservation segments. Stop all writers for upgrades, capacity migration and maintenance; old and new writers cannot be mixed.
- Unknown persisted record shapes require reviewed migration. Never redirect a validation failure to a new empty store.
