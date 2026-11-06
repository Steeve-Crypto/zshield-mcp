import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fsyncDir, readPrivate, safeRecordPath } from "../fsafe.js";

type Entry = { path: string; sha256: string; size: number; directory?: true };
type Manifest = { version: 1; created_at: string; entries: Entry[] };
const MAX_ENTRIES = 100000;
const validPath = (p: string) => typeof p === "string" && p.length < 4096 && p.split("/").every(s => s !== "" && s !== "." && s !== ".." && !/[\\\x00-\x1f]/.test(s)) && !p.startsWith("/");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function stamp(st: fs.Stats) { return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }
async function copyTree(source: string, target: string, path: string, entries: Entry[], fence: () => void): Promise<void> {
  await new Promise<void>(r => setImmediate(r)); fence();
  if (!validPath(path) || entries.length >= MAX_ENTRIES) throw new Error("Snapshot path or entry limit exceeded");
  source = safeRecordPath(source);
  const before = fs.lstatSync(source);
  if (before.isSymbolicLink()) throw new Error("Snapshot refuses symlinks");
  if (before.isDirectory()) {
    fs.mkdirSync(target, {mode:0o700});
    entries.push({path,sha256:"",size:0,directory:true});
    const names = fs.readdirSync(source).sort();
    for (const name of names) await copyTree(join(source,name),join(target,name),`${path}/${name}`,entries,fence);
    if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(source).sort())) throw new Error("Source directory changed during snapshot");
    fsyncDir(target);
    return;
  }
  if (!before.isFile()) throw new Error("Snapshot accepts regular files only");
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let output: number | undefined;
  try {
    if (stamp(fs.fstatSync(input)) !== stamp(before)) throw new Error("Snapshot source changed");
    output = fs.openSync(target, "wx", 0o600);
    const digest = createHash("sha256"), buffer = Buffer.alloc(1024*1024);
    let size = 0, n: number;
    while ((n = fs.readSync(input,buffer,0,buffer.length,null)) > 0) {
      digest.update(buffer.subarray(0,n));
      let written = 0;
      while (written < n) written += fs.writeSync(output,buffer,written,n-written);
      size += n;
      await new Promise<void>(r => setImmediate(r)); fence();
    }
    fs.fsyncSync(output);
    if (size !== before.size || stamp(fs.fstatSync(input)) !== stamp(before) || stamp(fs.lstatSync(source)) !== stamp(before)) throw new Error("Snapshot source changed during copy");
    entries.push({path,sha256:digest.digest("hex"),size});
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
}

/** Sources must be quiesced under BOTH application and backend wallet locks. */
export async function createSnapshot(sources: Record<string,string>, destination: string, fence: () => void) {
  destination = resolve(destination);
  for (const source of Object.values(sources)) {
    const root = resolve(source);
    if (destination === root || destination.startsWith(root+"/")) throw new Error("Snapshot must be outside its sources");
  }
  if (fs.existsSync(destination)) throw new Error("Snapshot destination must not exist");
  safeRecordPath(destination);
  const parent = fs.lstatSync(dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) throw new Error("Snapshot parent must be an existing private directory");
  const temp = destination + ".partial-" + randomBytes(8).toString("hex");
  fs.mkdirSync(temp,{mode:0o700});
  try {
    const entries: Entry[] = [];
    for (const [name, source] of Object.entries(sources)) {
      if (!/^[a-z][a-z0-9_.-]*$/.test(name)) throw new Error("Invalid snapshot source name");
      await copyTree(source,join(temp,name),name,entries,fence);
    }
    const manifest: Manifest = { version:1,created_at:new Date().toISOString(),entries };
    const json = JSON.stringify(manifest);
    if (Buffer.byteLength(json)>16*1024*1024) throw new Error("Snapshot manifest too large");
    const fd = fs.openSync(join(temp,"manifest.json"),"wx",0o600);
    try { fs.writeFileSync(fd,json); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
    fsyncDir(temp); fence();
    // Exclusive publication: destination must still be absent. Rename is only under
    // the trusted operator-owned parent; another operator must not reuse this path.
    if (fs.existsSync(destination)) throw new Error("Snapshot destination appeared");
    fs.renameSync(temp,destination);
    try {
      fsyncDir(dirname(destination));
    } catch (error) {
      // Publication was visible; remove the secret copy rather than leave it after a reported failure.
      try { fs.rmSync(destination,{recursive:true,force:true}); } catch { /* best effort */ }
      throw error;
    }
    return {manifest_sha256:hash(json),files:entries.filter(e=>!e.directory).length};
  } catch (error) {
    fs.rmSync(temp,{recursive:true,force:true});
    throw error;
  }
}

/** Restore to a NEW quarantine directory, never over an active wallet. */
export async function restoreSnapshot(source: string, destination: string, expectedDigest: string) {
  const raw = readPrivate(join(source,"manifest.json"),16*1024*1024);
  if (!raw || !/^[a-f0-9]{64}$/.test(expectedDigest) || hash(raw)!==expectedDigest) throw new Error("Snapshot manifest digest mismatch");
  const manifest = JSON.parse(raw) as Manifest;
  if (manifest.version!==1 || !Array.isArray(manifest.entries) || manifest.entries.length>MAX_ENTRIES) throw new Error("Invalid snapshot manifest");
  const seen = new Set<string>();
  for (const e of manifest.entries) {
    if (!validPath(e.path) || seen.has(e.path) || !Number.isSafeInteger(e.size) || e.size<0 || (!e.directory && !/^[a-f0-9]{64}$/.test(e.sha256))) throw new Error("Invalid snapshot entry");
    seen.add(e.path);
  }
  const roots: Record<string,string> = {};
  for (const e of manifest.entries) if (!e.path.includes("/")) roots[e.path] = join(source,e.path);
  if (!roots.wallet) throw new Error("Snapshot has no wallet");
  // Copy and hash the actual tree, then compare EVERY entry before making it usable.
  const staging = resolve(destination)+".restore-"+randomBytes(8).toString("hex");
  if (fs.existsSync(destination)) throw new Error("Restore target must not exist");
  try {
    await createSnapshot(roots,staging,()=>{});
    const actual = JSON.parse(readPrivate(join(staging,"manifest.json"),16*1024*1024)!).entries as Entry[];
    const sorted = (list: Entry[]) => JSON.stringify([...list].sort((a,b)=>a.path.localeCompare(b.path)));
    if (sorted(actual)!==sorted(manifest.entries)) throw new Error("Snapshot content differs from manifest");
    const state = join(staging,"wallet",".zshield-state");
    if (!fs.existsSync(state)) throw new Error("Snapshot has no payment state");
    const marker = fs.openSync(join(state,"payments.pause"),"w",0o600);
    try {fs.writeFileSync(marker,"Restored wallet: reconciliation and operator review required\n");fs.fsyncSync(marker);} finally {fs.closeSync(marker);}
    fsyncDir(state);
    if (fs.existsSync(destination)) throw new Error("Restore target appeared");
    fs.renameSync(staging,destination);
    try { fsyncDir(dirname(resolve(destination))); }
    catch (error) {
      try { fs.rmSync(destination,{recursive:true,force:true}); } catch { /* best effort */ }
      throw error;
    }
  } catch (error) {fs.rmSync(staging,{recursive:true,force:true});throw error;}
}
