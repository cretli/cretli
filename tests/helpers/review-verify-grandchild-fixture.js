// Fixture: spawns a non-detached grandchild that ignores SIGTERM, prints its
// pid, then blocks. The parent also ignores nothing, so SIGTERM kills only it.
import { spawn } from 'node:child_process';

const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  stdio: 'ignore',
});
console.log(`GRANDCHILD_PID=${grandchild.pid}`);
setInterval(() => {}, 1000);
