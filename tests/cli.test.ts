import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../src/cli.ts';
import { accountId, type Account, type LoginIO, type Provider } from '../src/types.ts';

const NOW = new Date('2026-11-18T22:00:00Z');

let dir: string;
let accounts: Account[];
let credentials: Map<string, unknown>;
let stdout: string;
let stderr: string;

const fakeProvider: Provider<{ token: string }> = {
  id: 'claude',
  login: async () => ({ credentials: { token: 'new' }, identity: 'me@example.com' }),
  needsRefresh: () => false,
  refresh: async (stored) => stored,
  fetchUsage: async () => ({
    plan: 'max',
    limits: [{ label: '5h', percent: 42, resetsAt: null, severity: 'normal' }],
  }),
};

const io: LoginIO = { print: () => undefined, prompt: async () => '', openUrl: async () => undefined };

function deps(): Partial<CliDeps> {
  return {
    providers: { claude: fakeProvider as Provider<unknown> },
    listAccounts: async () => accounts,
    upsertAccount: async (account) => {
      accounts = [...accounts.filter((existing) => accountId(existing) !== accountId(account)), account];
    },
    removeAccount: async (id) => {
      const before = accounts.length;
      accounts = accounts.filter((account) => accountId(account) !== id);
      return accounts.length !== before;
    },
    loadCredentials: async (id) => credentials.get(id) ?? null,
    saveCredentials: async (id, value) => void credentials.set(id, value),
    deleteCredentials: async (id) => void credentials.delete(id),
    io,
    out: (text) => (stdout += `${text}\n`),
    err: (text) => (stderr += `${text}\n`),
    now: () => NOW,
    color: false,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-cli-'));
  process.env.AI_USAGE_CONFIG_DIR = dir;
  accounts = [];
  credentials = new Map();
  stdout = '';
  stderr = '';
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('aiu', () => {
  it('prints a hint when no accounts are configured', async () => {
    expect(await main([], deps())).toBe(0);
    expect(stdout).toContain('No accounts yet. Add one with: aiu login <claude|chatgpt> --name <label>');
  });

  it('prints the usage table by default', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    credentials.set('claude/personal', { token: 't' });
    expect(await main([], deps())).toBe(0);
    expect(stdout).toContain('claude/personal');
    expect(stdout).toContain(' 42 %');
  });

  it('prints JSON with --json', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    credentials.set('claude/personal', { token: 't' });
    expect(await main(['--json'], deps())).toBe(0);
    expect(JSON.parse(stdout).accounts[0]).toMatchObject({ id: 'claude/personal', status: 'ok' });
  });

  it('exits 0 even when an account fails', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    expect(await main([], deps())).toBe(0);
    expect(stdout).toContain('No credentials stored');
  });
});

describe('aiu login', () => {
  it('stores credentials and the account with its identity', async () => {
    expect(await main(['login', 'claude', '--name', 'personal'], deps())).toBe(0);
    expect(credentials.get('claude/personal')).toEqual({ token: 'new' });
    expect(accounts).toEqual([{ provider: 'claude', label: 'personal', identity: 'me@example.com' }]);
    expect(stdout).toContain('Added claude/personal (me@example.com)');
  });

  it('accepts an e-mail address as label', async () => {
    expect(await main(['login', 'claude', '--name', 'ja+ai@pvachek.cz'], deps())).toBe(0);
    expect(credentials.has('claude/ja+ai@pvachek.cz')).toBe(true);
  });

  it.each([['Bad Name'], ['_x'], ['a'.repeat(65)], ['a"b'], ['a/b']])('rejects the label %s', async (label) => {
    expect(await main(['login', 'claude', '--name', label], deps())).toBe(2);
    expect(stderr).toContain('Invalid label');
  });

  it('rejects a missing label and an unknown provider', async () => {
    expect(await main(['login', 'claude'], deps())).toBe(2);
    expect(await main(['login', 'gemini', '--name', 'x'], deps())).toBe(2);
  });

  it('rejects a provider that is not implemented and lists only implemented ones', async () => {
    expect(await main(['login', 'grok', '--name', 'main'], deps())).toBe(2);
    expect(stderr).toContain('Unknown provider: grok. Use one of: claude\n');
  });
});

describe('aiu accounts / remove', () => {
  it('lists accounts with identity', async () => {
    accounts = [{ provider: 'claude', label: 'personal', identity: 'me@example.com' }];
    expect(await main(['accounts'], deps())).toBe(0);
    expect(stdout).toContain('claude/personal  me@example.com');
  });

  it('removes an account and its credentials', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    credentials.set('claude/personal', { token: 't' });
    expect(await main(['remove', 'claude/personal'], deps())).toBe(0);
    expect(accounts).toEqual([]);
    expect(credentials.has('claude/personal')).toBe(false);
  });

  it('keeps the account listed when the Keychain refuses to delete its credentials', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    const failingDelete = async () => {
      throw new Error('Keychain delete failed');
    };
    expect(await main(['remove', 'claude/personal'], { ...deps(), deleteCredentials: failingDelete })).toBe(1);
    expect(accounts).toEqual([{ provider: 'claude', label: 'personal' }]);
    expect(stderr).toContain('Keychain delete failed');
  });

  it('fails for an unknown account', async () => {
    expect(await main(['remove', 'claude/nobody'], deps())).toBe(1);
    expect(stderr).toContain('No such account: claude/nobody');
  });
});

describe('help and unknown input', () => {
  it('prints usage for --help', async () => {
    expect(await main(['--help'], deps())).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('exits 2 for an unknown command or option', async () => {
    expect(await main(['frobnicate'], deps())).toBe(2);
    expect(await main(['--bogus'], deps())).toBe(2);
    expect(stderr).toContain('Usage:');
  });
});
