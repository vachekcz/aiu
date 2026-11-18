import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deleteSecret, readSecret, writeSecret } from '../../src/store/keychain.ts';

const SERVICE = 'ai-usage-test';
const ACCOUNT = 'test/probe';

const itemExists = (item: string): boolean => {
  try {
    execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', item], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('keychain store (real macOS Keychain)', () => {
  beforeAll(() => {
    process.env.AI_USAGE_KEYCHAIN_SERVICE = SERVICE;
  });

  afterEach(async () => {
    await deleteSecret(ACCOUNT);
  });

  it('round-trips a short JSON value', async () => {
    const value = JSON.stringify({ accessToken: 'abc', refreshToken: 'def', expiresAt: 1 });
    await writeSecret(ACCOUNT, value);
    expect(await readSecret(ACCOUNT)).toBe(value);
  });

  it('round-trips a value longer than the security -i line limit', async () => {
    const value = randomBytes(6000).toString('base64');
    expect(value.length).toBe(8000);
    await writeSecret(ACCOUNT, value);
    expect(await readSecret(ACCOUNT)).toBe(value);
  });

  it('removes stale chunks when a long value is replaced by a short one', async () => {
    await writeSecret(ACCOUNT, randomBytes(6000).toString('base64'));
    expect(itemExists(`${ACCOUNT}#2`)).toBe(true);
    await writeSecret(ACCOUNT, 'short-1234');
    expect(await readSecret(ACCOUNT)).toBe('short-1234');
    expect(itemExists(`${ACCOUNT}#1`)).toBe(false);
    expect(itemExists(`${ACCOUNT}#2`)).toBe(false);
  });

  it('returns null for a missing account', async () => {
    expect(await readSecret('test/does-not-exist')).toBeNull();
  });

  it('deletes all items of an account', async () => {
    await writeSecret(ACCOUNT, randomBytes(6000).toString('base64'));
    await deleteSecret(ACCOUNT);
    expect(await readSecret(ACCOUNT)).toBeNull();
    expect(itemExists(`${ACCOUNT}#0`)).toBe(false);
  });

  it('rejects account names that would need shell quoting', async () => {
    await expect(writeSecret('bad "name"', 'x')).rejects.toThrow('Invalid keychain account name');
  });
});
