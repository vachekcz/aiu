import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './store/accounts.ts';

const RETRY_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isStale(lockFile: string, staleMs: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockFile);
    return Date.now() - mtimeMs > staleMs;
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
