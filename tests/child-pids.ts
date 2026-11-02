import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";

/** Linux /proc may expose outer PIDs while process.kill expects our PID namespace. */
export function childPids(parent: number, command: string): number[] {
  if (process.platform !== "linux") {
    return execFileSync("pgrep", ["-P", String(parent), command]).toString().trim().split("\n").map(Number);
  }
  const namespace = readlinkSync("/proc/self/ns/pid");
  const processes: { pid: number; outer: number; parent: number; command: string }[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const root = `/proc/${name}`;
      if (readlinkSync(`${root}/ns/pid`) !== namespace) continue;
      const status = readFileSync(`${root}/status`, "utf8");
      const namespacePids = status.match(/^NSpid:\s*(.+)$/m)?.[1].trim().split(/\s+/);
      processes.push({
        pid: Number(namespacePids?.at(-1) ?? name),
        outer: Number(name),
        parent: Number(status.match(/^PPid:\s*(\d+)/m)?.[1]),
        command: readFileSync(`${root}/comm`, "utf8").trim(),
      });
    } catch { /* a process can exit while /proc is enumerated */ }
  }
  const outerParent = processes.find((p) => p.pid === parent)?.outer;
  return processes.filter((p) => p.parent === outerParent && p.command === command).map((p) => p.pid);
}
