import fs from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { safeRecordPath } from "../fsafe.js";

/**
 * A pinned executable refused. `unsafe` means the file itself cannot be trusted, whatever its
 * digest, and `reason` says why; otherwise its content or identity is not the approved one.
 */
export class PinRefusedError extends Error {
 constructor(readonly unsafe:boolean,readonly reason:string){
  super(unsafe?`The configured wallet executable is refused: it ${reason}.`:"The configured wallet executable does not match its approved identity.");
  this.name="PinRefusedError";
 }
}

/** Hash once, then refuse any inode, metadata or namespace change before execution. */
export function pinExecutable(path: string, expectedSha256: string): () => void {
 const changed=():never=>{throw new PinRefusedError(false,"its content or identity changed");};
 const unsafe=(reason:string):never=>{throw new PinRefusedError(true,reason);};
 if(!isAbsolute(path))unsafe("is not an absolute path");
 if(!/^[a-f0-9]{64}$/.test(expectedSha256))changed();
 safeRecordPath(path);
 const stamp=(st:fs.Stats)=>`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.uid}`;
 const look=()=>{
  try{return fs.lstatSync(path);}
  catch(e){const code=(e as NodeJS.ErrnoException).code;return code==="ENOENT"?unsafe("does not exist"):unsafe(`cannot be read (${code})`);}
 };
 const check=(st:fs.Stats)=>{
  if(st.isSymbolicLink())unsafe("is a symlink; point the setting at the real file");
  if(!st.isFile())unsafe("is not a regular file");
  if((st.mode&0o022)!==0)unsafe("is writable by group or others (chmod go-w)");
  if((st.mode&0o111)===0)unsafe("is not executable");
  if(process.getuid&&st.uid!==process.getuid()&&st.uid!==0)unsafe(`is owned by another user (uid ${st.uid}); it must be yours or root's`);
 };
 const initial=look();check(initial);
 const fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try {
  if(stamp(fs.fstatSync(fd))!==stamp(initial))changed();
  const hash=createHash("sha256"),buffer=Buffer.alloc(1024*1024);
  let n:number;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));
  if(hash.digest("hex")!==expectedSha256||stamp(fs.fstatSync(fd))!==stamp(initial))changed();
 }finally{fs.closeSync(fd);}
 return ()=>{safeRecordPath(path);const now=look();check(now);if(stamp(now)!==stamp(initial))changed();};
}
