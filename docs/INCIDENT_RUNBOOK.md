# Payment incident runbook

This revision is not approved for financial deployment without native and independent qualification. See [review evidence](../V12-RUN14-RESPONSE.md).

## Stuck or uncertain payment

1. Pause payments with the operator CLI procedure in [operator controls](OPERATOR_CONTROLS.md).
2. Preserve the wallet, payment store, audit files, fallback and all budget counters using a coordinated snapshot. Never prune evidence or delete an idempotency binding.
3. Query payment_status using the original key or call id. An unknown or failed observation is not proof of non-payment. Do not substitute a new key.
4. Resume only the original transaction through the original key, after restoring audit capacity and policy approvals. A tracked transaction without transmit authorization cannot be revived. Do not manually transmit its staged transaction.
5. If another unresolved payment blocks recovery, reconcile that payment first. Do not clear its pending marker to bypass the interlock.
6. Verify the exact txid and output details using the pinned native wallet before reviewed unpause. A test fixture is not native evidence.

## Audit disk full or AUDIT_WRITE_FAILED

1. Pause. Keep the caller's original key and any returned txid. A result-log failure after transmission does not undo the payment.
2. Check both audit destinations, filesystem free blocks, free inodes, quotas and permissions. Default primary and fallback usually share a filesystem.
3. Archive only through a coordinated offline maintenance procedure with verified backups. Do not reset monotonic budget counters on a live writer.
4. Export and preserve both reserved payment journals using the [journal runbook](PAYMENT_AUDIT_JOURNAL.md). JSONL may be missing a committed payment mirror. Increase storage or migrate capacity only with every writer stopped; never replace the published journal to clear an error.
5. Rehearse recovery and check operator health before reviewed unpause. Free disk bytes do not prove a remaining journal slot. Uncommitted slots remain charged.

## Key binding failure

1. Preserve the failure and inspect the original call. Publication and durable publication are different.
2. A failed binding must never permit a send. The name can remain visible after fsync fails.
3. Retry only the same key and identical parameters after storage is healthy. The server releases a failed binding only under its wallet lock with an explicit key_binding_failed no-send record and no staged or returned txid.
4. If that proof is absent or unreadable, stop. Never unlink the binding by hand. Investigate using a coordinated snapshot.

## Restart or shutdown

A bounded graceful drain is not implemented. Treat termination as a crash boundary. Supervise the process, preserve its state, and reconcile original calls after restart. Do not assume stopping the server stopped an already running backend or undid a broadcast.
