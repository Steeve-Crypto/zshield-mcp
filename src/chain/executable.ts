import fs from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { safeRecordPath } from "../fsafe.js";

/** Hash once, then refuse any inode, metadata or namespace change before execution. */
export function pinExecutable(path: string, expectedSha256: string): () => void {
 const fail=()=>{throw new Error("The configured wallet executable does not match its approved identity.");};
 if(!isAbsolute(path)||!/^[a-f0-9]{64}$/.test(expectedSha256))return fail();
 safeRecordPath(path);
 const stamp=(st:fs.Stats)=>`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.uid}`;
 const check=(st:fs.Stats)=>{
  if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o022)!==0||(st.mode&0o111)===0 || (process.getuid && st.uid!==process.getuid() && st.uid!==0))fail();
 };
 const initial=fs.lstatSync(path);check(initial);
 const fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try {
  if(stamp(fs.fstatSync(fd))!==stamp(initial))fail();
  const hash=createHash("sha256"),buffer=Buffer.alloc(1024*1024);
  let n:number;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));
  if(hash.digest("hex")!==expectedSha256||stamp(fs.fstatSync(fd))!==stamp(initial))fail();
 }finally{fs.closeSync(fd);}
 return ()=>{safeRecordPath(path);const now=fs.lstatSync(path);check(now);if(stamp(now)!==stamp(initial))fail();};
}
