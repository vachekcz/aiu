import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './store/accounts.ts';

const RETRY_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function unlinkIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
  });
}

const readOwner = (lockFile: string): Promise<string | null> =>
  readFile(lockFile, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });

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
    const pid = Number((await readFile(lockFile, 'utf8')).split(' ')[0]);
    return Number.isInteger(pid) && pid > 0 && isProcessGone(pid);
  } catch {
    return false;
  }
}

async function tryAcquire(lockFile: string, owner: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockFile, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(owner);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkIfPresent(lockFile);
    throw error;
  }
  await handle.close();
  return true;
}

/**
 * Cross-process mutex based on an exclusively created lock file in `<configDir>/locks`.
 * Guards token refreshes: refresh tokens rotate, so two concurrent refreshes would log one run out.
 * The file holds "<pid> <random token>"; only the holder whose token is still in the file releases it,
 * so a holder whose lock was taken over as stale cannot delete the new holder's lock.
 */
export async function withFileLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, staleMs = 60_000 } = options;
  const lockDir = join(configDir(), 'locks');
  const lockFile = join(lockDir, `${name}.lock`);
  const owner = `${process.pid} ${randomBytes(8).toString('hex')}`;
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  while (!(await tryAcquire(lockFile, owner))) {
    if (await isStale(lockFile, staleMs)) {
      await unlinkIfPresent(lockFile);
    } else {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${name}`);
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    // Releasing is best effort: a leftover lock goes stale once this process exits.
    if ((await readOwner(lockFile).catch(() => null)) === owner) await unlinkIfPresent(lockFile).catch(() => undefined);
  }
}
