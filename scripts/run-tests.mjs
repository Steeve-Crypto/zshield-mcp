import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Discover recursively so adding a regression never requires editing package.json.
function tests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tests(path) : entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
const files = tests("tests").sort();
if (!files.length) throw new Error("No test files discovered");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=4", ...process.argv.slice(2), ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
