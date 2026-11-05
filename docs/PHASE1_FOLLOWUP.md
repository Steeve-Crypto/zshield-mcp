# Phase 1 follow-up findings

Scope: V12 findings against ee66902 in the attached Phase 1 report.

| Finding | Root cause addressed | Regression evidence |
| --- | --- | --- |
| #327841 | Signed identity, transmit authorization and network acknowledgement are distinct. Proven pre-start failures release the interlock. A crash after authorization resumes only the original signed transaction, under the wallet lock, with no replacement calculation. Older staged calls have explicit same-key resume. | `tests/resume.test.ts`: process SIGKILL after authorization, durable-operation crash matrix, concurrent resumers, lost reply and failed result write. `tests/v12-phase1-review.test.ts`: local non-transmission proof. |
| #327842 | Non-root URL paths are potentially credential-bearing at admission and in diagnostics. HTTPS, opt-in and safe secret length checks apply; raw/decoded segments are redacted. Ambiguous dot-segment and backslash spellings are refused before URL normalization. | `tests/v12-phase1-review.test.ts`: raw/encoded paths, HTTPS, opt-in, minimum length and dot-segment cases. |
| #327847 | MCP read commands and sync consume one deadline. Termination completes before unlocking. A waiting writer owns the cross-process admission gate before waiting behind a local read. Live sends outwait an admitted read. | `tests/v12-phase1-review.test.ts`: sequential command budgets, sync budget, SIGTERM-resistant subprocess and writer turnstile. Existing lock/race invariants. |
| #327849 | Reservations use a fixed counter inode per pool, protected by OS flock and fsync before append. Diagnostic row count no longer creates one permanent file per row. Legacy charges are retained. | `tests/v12-phase1-review.test.ts`: constant inode count, independent financial capacity, concurrent processes and upgrade charges. Rejected resumes use diagnostic capacity, preserving financial reservations. Existing audit durability/fallback invariants. |

Ownership checks also execute when tests run as root: controlled foreign-owner stat
metadata reaches the production refusal paths, with positive checks after restoration.
This does not claim an OS-level multi-user permission experiment.

Failed/expired/missing transactions and revoked policy cannot safely authorize a new
payment. A backend that refuses the original bytes may still require investigation.
Local test success is not a fresh V12 approval or a funded testnet integration result.

## Local validation

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm test`: 516 tests passed, zero failures, zero skips.
- The resume sweep verified 26 instrumented durable-write crash points.
- Tests run against the final source include the audit-capacity isolation and original
  call status fixes, not just the initial outbox implementation.
