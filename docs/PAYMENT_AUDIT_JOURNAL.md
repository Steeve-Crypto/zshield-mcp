# Reserved payment evidence

## Storage contract

Payment evidence is stored in `payment-evidence.bin` inside each sink's canonical `.budget` directory. Primary and fallback each receive their own reservation, even when they share a filesystem. Before accepting caller-driven audit traffic, startup attempts both reservations. At least one destination must be usable or startup fails. Each write also checks its destination, so library callers cannot bypass initialization.

The implementation writes actual zero-filled blocks in bounded chunks, fsyncs the whole segment, then publishes it with an exclusive hard link and fsyncs the directory. It does not use sparse truncation as preallocation. It checks the allocated block count before trusting a reservation. A partial temporary file is never published as ready. A retry opens the same published inode and never clears its contents.

Only qualified Linux ext4 and XFS destinations are accepted. Do not reflink, deduplicate or compress a live segment. Other filesystems, platform guarantees and the actual storage stack require separate qualification. No software reservation protects against failed hardware, an administrator deleting the file or an underlying storage service violating its durability contract.

The existing audit limit remains a lifetime logical allowance, not a rolling daily limit. Each logical 8193-byte allowance uses a 12288-byte physical slot, plus one 4096-byte segment header. The default 64 MiB allowance therefore allocates about 96 MiB per destination, about 192 MiB for primary plus fallback. Initialization can fail with insufficient capacity; never substitute a sparse file to get past that failure.

## Slot protocol

Writers inherit the same open journal inode into the existing Perl runtime and take an OS flock on it. Under that lock, a writer finds an unused slot, records and fsyncs an incomplete marker, writes a byte length, SHA-256 digest and bounded JSON record, fsyncs that payload, then records and fsyncs its committed marker before acknowledging durability. No step grows the segment.

An interrupted slot stays consumed. It is not reclaimed by a lease, age check, restart or caller retry. Unknown markers and dirty unused slots fail closed. Complete records are checksummed when exported. Checksums detect accidental damage; they are not signatures or protection against a trusted OS user rewriting the journal.

Legacy baseline bytes and old payment counters remain charged. New payment rows consume journal slots rather than creating more counter metadata during disk exhaustion. Health includes committed and incomplete slots when reporting remaining usable capacity. A larger configured allowance than the existing physical segment requires an offline migration; the server never replaces evidence to grow capacity.

## Traffic logs and compatibility

Refusal and diagnostic rows are written only to the ordinary bounded JSONL traffic files. They never enter the reserved journal. Payment JSONL copies remain as best-effort compatibility mirrors, bounded by the finite number of payment slots. A full traffic filesystem can prevent a refusal row from being logged; the MCP result then fails closed with a generic audit error.

If the payment journal is durable but the JSONL mirror cannot be written, the payment retains its durable evidence and returns a warning identifying the missing mirror. Do not interpret absence from JSONL as proof that no payment happened. Never hide a returned txid because the result mirror failed. The original payment store remains the source for idempotency and reconciliation.

## Operator export and maintenance

Export complete reserved evidence locally:

```
npm run audit:payments -- /absolute/path/to/audits.budget/payment-evidence.bin
npm run audit:payments -- /absolute/path/to/audit-fallback.jsonl.budget/payment-evidence.bin
```

Output contains sensitive payment details. Keep it private. Incomplete-slot counts go to stderr; never reset those slots while writers are live. Corrupt records cause the export to fail rather than silently skip them. Coordinated snapshots already include both `.budget` directories and therefore include these journals. Snapshot copying uses explicit reads and writes, not reflinks.

Stop every old and new writer before upgrading, changing the configured allowance, archiving, restoring or migrating a segment. Mixed-version writers and unreviewed rollback are unsupported. Keep old JSONL files, baseline records and counters. Validate a coordinated snapshot and the exported evidence before reviewed unpause. Temporary `.tmp-reservation-*` files left by a killed initializer can consume disk; inspect and reclaim them only during coordinated offline maintenance after confirming no writer owns them. Never delete the published segment, a key binding or a pending marker to recover capacity.

## Local qualification and limits

Tests verify real allocated blocks, fixed file size and block count across writes, nonpayment ENOSPC while reserved payment evidence still commits, allocation failure, SIGKILL during initialization, restart reuse, incomplete-slot retention, capacity exhaustion, old-counter migration and concurrent process slot ownership. Disk-write faults are injected; this is not a destructive full-volume or host-power-loss test.

Native-wallet qualification, actual deployment storage exhaustion and power-loss rehearsals, and independent review remain release gates. A finite journal can still fill with legitimate payment evidence. Pending intent evidence must commit before a send; if all destinations are exhausted, no new send is authorized. A post-send evidence failure must retain the original identity and report a warning, never authorize a replacement payment.
