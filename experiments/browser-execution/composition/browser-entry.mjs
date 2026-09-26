// Trust only the dedicated synthetic test CA in this container's empty private HOME.
import { mkdir, copyFile, chmod } from 'node:fs/promises';
const directory='/tmp/.local/share/pki/nssdb';
await mkdir(directory,{recursive:true,mode:0o700});
for(const name of ['cert9.db','key4.db']) {
 await copyFile('/fixture-trust/'+name,directory+'/'+name);
 await chmod(directory+'/'+name,0o600);
}
await import('/service/src/index.ts');
