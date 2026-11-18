import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './store/accounts.ts';

const RETRY_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** A lock is stale when it is old or its holder is gone (e.g. a run killed by Ctrl-C, which skips `finally`). */
async function isStale(lockFile: string, staleMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockFile);
    if (Date.now() - mtimeMs > staleMs) return true;
    const pid = Number((await readFile(lockFile, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 && isProcessGone(pid);
  } catch {
    return false;
  }
}

/**
 * Cross-process mutex based on an exclusively created lock file in `<configDir>/locks`.
 * Guards token refreshes: refresh tokens rotate, so two concurrent refreshes would log one run out.
 */
export async function withFileLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, staleMs = 60_000 } = options;
  const lockDir = join(configDir(), 'locks');
  const lockFile = join(lockDir, `${name}.lock`);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockFile, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await isStale(lockFile, staleMs)) {
        await unlink(lockFile).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${name}`);
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockFile).catch(() => undefined);
  }
}
