// Takes the wallet lock for a store folder and holds it. argv: <dir> <hold ms>
// Prints "acquired", then releases and exits after the hold time (or never, if killed first).
import { acquireWalletLock } from "../../../src/payments/lock.ts";
const [dir, ms] = process.argv.slice(2);
const lock = await acquireWalletLock({ dir, requireOsLock: true }, 0, "inv-holder");
process.stdout.write("acquired\n");
setTimeout(async () => {
  await lock.release();
  process.exit(0);
}, Number(ms));
