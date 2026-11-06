import { readPaymentEvidence } from "../src/audit/reservation.js";
// Operator-only export. Output contains sensitive payment audit records; keep it private.
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error("Usage: tsx scripts/audit-payments.ts /absolute/path/payment-evidence.bin");
const result = readPaymentEvidence(file);
for (const row of result.rows) process.stdout.write(JSON.stringify(row) + "\n");
if (result.incomplete) process.stderr.write(`${result.incomplete} incomplete reserved slots retained; do not reset while writers are live.\n`);
