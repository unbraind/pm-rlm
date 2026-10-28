import { acquireLock } from '@unbrained/pm-cli/sdk';

const [workspace, id] = process.argv.slice(2);
// Hold a real SDK lease lock until the parent kills this writer, leaving a dead-owner lock.
await acquireLock(workspace, id, 60, 'pm-rlm', false, false, 0);
process.send!({ held: true });
await new Promise(() => { setInterval(() => { /* stay alive until SIGKILL */ }, 60_000); });
