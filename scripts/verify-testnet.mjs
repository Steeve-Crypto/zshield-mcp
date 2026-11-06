// Release verification must fail, rather than silently skip, without its prerequisites.
import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const name of ["ZSHIELD_TESTNET_ZINGO_BIN", "ZSHIELD_TESTNET_WALLET"]) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) {
    console.error(`${name} must name an absolute path. Testnet verification did not run.`);
    process.exit(1);
  }
}
accessSync(process.env.ZSHIELD_TESTNET_ZINGO_BIN, constants.X_OK);
accessSync(join(process.env.ZSHIELD_TESTNET_WALLET, "zingo-wallet.dat"), constants.R_OK | constants.W_OK);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "tests/invariants/testnet.test.ts"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, ZSHIELD_TESTNET_INVARIANTS: "1" },
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
