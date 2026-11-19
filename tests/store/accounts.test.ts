import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configDir, listAccounts, removeAccount, upsertAccount } from '../../src/store/accounts.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-accounts-'));
  process.env.AI_USAGE_CONFIG_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('accounts store', () => {
  it('returns an empty list when the file does not exist', async () => {
    expect(await listAccounts()).toEqual([]);
  });

  it('appends new accounts and replaces existing ones in place', async () => {
    await upsertAccount({ provider: 'claude', label: 'personal' });
    await upsertAccount({ provider: 'chatgpt', label: 'pro' });
    await upsertAccount({ provider: 'claude', label: 'personal', identity: 'me@example.com' });

    expect(await listAccounts()).toEqual([
      { provider: 'claude', label: 'personal', identity: 'me@example.com' },
      { provider: 'chatgpt', label: 'pro' },
    ]);
  });

  it('treats an empty AI_USAGE_CONFIG_DIR as unset', () => {
    process.env.AI_USAGE_CONFIG_DIR = '';
    expect(configDir()).toBe(join(homedir(), '.config', 'ai-usage'));
  });

  it('removes an account and reports whether it existed', async () => {
    await upsertAccount({ provider: 'grok', label: 'main' });
    expect(await removeAccount('grok/main')).toBe(true);
    expect(await removeAccount('grok/main')).toBe(false);
    expect(await listAccounts()).toEqual([]);
  });
});
