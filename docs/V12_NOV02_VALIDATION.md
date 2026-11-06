# November 2 V12 follow-up

Base: `b25ff421d962f5f9d2b48f20bd1046561150fb39` (PR #3).
Findings: #327483, #327484, #327495.

## Reproduction and scope

The same entry-point probes against the audited base and patched source produced:

| Probe | Audited base | Patched source |
| --- | --- | --- |
| Missing signed transaction after the finite height/time margin | terminal `expired` | `unknown`, pending and interlocked |
| Intermediate symlink owned by another uid (ownership fixture) | accepted after canonicalization | rejected before following it |
| CLI JSON and listing both exceed 16 MiB | history fails | selected txid resolved and corroborated |

The deep-reorg regression changes the wallet view after an initial absence: the
original signed txid is then reported mined below its expiry. This is a deterministic
wallet-view simulation, not a live network reorg. A second test seeds an old expired
record with its pending marker removed, restarts the store, and verifies re-indexing,
new-key refusal, and subsequent positive recovery. Wallet-reported failed signed
transactions remain interlocked too; they are not irreversible non-payment proofs.

The large-history fixture is a real child process that emits more than 16 MiB of
machine-readable notes and more than 16 MiB of transaction listing before the target.
The process reader streams both; it retains only bounded selected evidence. Tests also
cover duplicate occurrences after the real entry, incomplete JSON, fake JSON embedded
inside a memo, and oversized unrelated records preceding the selected transaction.
No unsafe full-history fallback runs after a failed exact lookup.

The path regressions use real directories and a real alias retarget after first use.
The ownership check uses an `lstat` uid fixture because this container cannot chown to
an unmapped uid. It covers the independent fallback at startup as well. Runtime record
helpers validate every lexical ancestor before following aliases, validate resolved
ancestors, retain canonical parent identities, and open canonical paths. Accepted
components must be controlled by root or the service uid; sticky shared directories
protect the next owned component. Root/service-uid compromise is outside this boundary.
Windows mock-mode ACL protection is unchanged; live mode still refuses Windows.

## Verification

`tests/v12-nov02.test.ts` contains the new regression cases. Existing expiry tests now
assert uncertainty instead of the invalid finality assumption. Existing positive
matching, memo corroboration, idempotency, staging, lock, crash and reorg tests remain.
The mocked history adapter explicitly implements the new optional identity lookup;
the single-flight fixture waits for a send-start signal rather than a 30 ms delay.

Commands: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.
The complete suite includes the multi-process crash matrix at every durable operation.
No real testnet funds were moved, and no new V12 verdict is claimed.

The added `stream-json` 3.8.0 and `stream-chain` 4.4.1 packages have no advisories in
the dependency scan used here. Baseline and patched production dependency scans both
report the same five pre-existing advisories (two high, three moderate), in body-parser,
fast-uri, ip-address, qs, and zod. They are not silently fixed or declared harmless by
this patch; upgrading those existing dependencies needs a separate compatibility review.

## Operational limits

The upstream CLI has no txid-filtered `transactions` command. Identity lookup therefore
streams its entire output under the existing overall timeout instead of buffering the
whole wallet. Memory is bounded by parser depth/field/record and selected-result limits;
time still grows with CLI traversal. Extremely large or malformed wallets can still
require backend/operator intervention. Ordinary recent-history reads and legacy
content-only matching retain their existing limits; they are no longer the dependency
for known-identity recovery. Unresolvable signed sends remain interlocked rather than
being misreported as never paid. Local `not_sent` proof requires the adapter's explicit
`stagesBeforeBroadcast` contract and a missing staged/returned txid.

References: [ZIP 203](https://zips.z.cash/zip-0203),
[upstream CLI commands](https://github.com/zingolabs/zingolib/blob/dev/zingo-cli/src/commands.rs),
[stream-json token parser](https://github.com/uhop/stream-json/blob/master/src/core/parser.js).
