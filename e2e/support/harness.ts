/**
 * ============================================================================
 * SPEC-TO-HARNESS REQUESTS: KILL, RESTART, BACKUP, RESTORE (support/harness.ts)
 * ============================================================================
 *
 * PURPOSE:
 * -----
 * Lets the journey ask `e2e/scripts/run-e2e.sh` (on the host, with the
 * Docker CLI) to act on the stack mid-session while both recorded browsers
 * stay open: SIGKILL the server, restart it, take a `pg_dump`, or wipe the
 * database volume and restore that dump. The spec has no Docker access, so
 * the shared `artifacts/harness` directory is the only channel.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -----
 * 1. `One Request At A Time`:
 *    - `{seq}-{action}.request` is written, then the call blocks until the
 *      harness writes `{seq}-{action}.done` (`ok` or `failed`); the harness
 *      runs requests in arrival order and the spec never overlaps them.
 * 2. `Closed Action List`:
 *    - Only the `HarnessAction` names exist; the harness refuses anything
 *      else, so the spec cannot run arbitrary commands on the host.
 * 3. `Bounded Wait, Loud Failure`:
 *    - A request not done within `HARNESS_TIMEOUT_MS` (or done with
 *      `failed`) throws with the tail of the harness log for that request.
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Actions `run-e2e.sh` performs on the Compose stack. */
export type HarnessAction = 'sigkill' | 'restart' | 'backup' | 'restore';

/** Longest wait for one harness action (ms); a restore re-creates PostgreSQL. */
const HARNESS_TIMEOUT_MS = 5 * 60_000;

let seq = 0;

/** Asks the host harness to run `action` and waits until it is done (invariant 1). */
export async function harness(artifacts: string, action: HarnessAction): Promise<string> {
  const dir = join(artifacts, 'harness');
  mkdirSync(dir, { recursive: true });
  seq += 1;
  const name = `${String(seq).padStart(2, '0')}-${action}`;
  const done = join(dir, `${name}.done`);
  const started = Date.now();
  writeFileSync(join(dir, `${name}.request`), '');
  while (!existsSync(done)) {
    if (Date.now() - started > HARNESS_TIMEOUT_MS) throw new Error(`harness ${action}: no answer within ${HARNESS_TIMEOUT_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const status = readFileSync(done, 'utf8').trim();
  const logFile = join(dir, `${name}.log`);
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim() : '';
  if (status !== 'ok') throw new Error(`harness ${action} ${status}: ${log.split('\n').slice(-5).join(' | ')}`);
  return `${action} done in ${Math.round((Date.now() - started) / 1000)}s`;
}
