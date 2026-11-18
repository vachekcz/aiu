import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from '../src/lock.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-lock-'));
  process.env.AI_USAGE_CONFIG_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withFileLock', () => {
  it('serialises holders of the same lock', async () => {
    const events: string[] = [];
    const holder = (name: string) =>
      withFileLock('claude__personal', async () => {
        events.push(`${name}:start`);
        await sleep(30);
        events.push(`${name}:end`);
      });

    await Promise.all([holder('a'), holder('b')]);

    expect(events).toHaveLength(4);
    expect(events[1]).toBe(`${events[0]!.split(':')[0]}:end`);
  });

  it('returns the callback result and releases the lock on error', async () => {
    await expect(withFileLock('x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withFileLock('x', async () => 42, { timeoutMs: 200 })).toBe(42);
  });

  it('takes over a stale lock file', async () => {
    const lockFile = join(dir, 'locks', 'stale.lock');
    await mkdir(join(dir, 'locks'), { recursive: true });
    await writeFile(lockFile, '999999');
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile, old, old);

    expect(await withFileLock('stale', async () => 'ok', { timeoutMs: 200, staleMs: 60_000 })).toBe('ok');
  });

  it('takes over a fresh lock whose holder process is gone', async () => {
    const lockFile = join(dir, 'locks', 'orphan.lock');
    await mkdir(join(dir, 'locks'), { recursive: true });
    await writeFile(lockFile, '999999');

    expect(await withFileLock('orphan', async () => 'ok', { timeoutMs: 200, staleMs: 60_000 })).toBe('ok');
  });

  it('times out while a fresh lock is held', async () => {
    let releaseHolder!: () => void;
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => (markHeld = resolve));
    const holder = withFileLock('busy', () => {
      markHeld();
      return new Promise<void>((resolve) => (releaseHolder = resolve));
    });
    try {
      await held;
      await expect(withFileLock('busy', async () => 'never', { timeoutMs: 100 })).rejects.toThrow(
        'Timed out waiting for lock',
      );
    } finally {
      releaseHolder();
      await holder;
    }
  });

  it('does not release a lock that another holder took over', async () => {
    const lockFile = join(dir, 'locks', 'taken.lock');
    await withFileLock('taken', async () => {
      // Simulates a waiter that judged this lock stale and acquired it meanwhile.
      await writeFile(lockFile, '1 someone-else');
    });
    expect(await readFile(lockFile, 'utf8')).toBe('1 someone-else');
  });

  it('fails instead of spinning when a stale lock cannot be removed', async () => {
    const lockDir = join(dir, 'locks');
    await mkdir(lockDir, { recursive: true });
    const lockFile = join(lockDir, 'stuck.lock');
    await writeFile(lockFile, '999999');
    await chmod(lockDir, 0o500);
    try {
      await expect(withFileLock('stuck', async () => 'never', { timeoutMs: 200 })).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(lockDir, 0o700);
    }
  });
});
