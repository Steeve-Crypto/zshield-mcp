// Appends N rows near the audit row limit to one file with appendPrivate, like N servers
// sharing one audit file. argv: <file> <tag> <rows>
import { appendPrivate } from "../../../src/fsafe.ts";
const [file, tag, rows] = process.argv.slice(2);
for (let i = 0; i < Number(rows); i++) {
  const row = JSON.stringify({ tag, i, pad: "x".repeat(8000 - 60 - String(i).length) }) + "\n";
  appendPrivate(file, row);
}
