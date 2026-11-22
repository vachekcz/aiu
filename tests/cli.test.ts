import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../src/cli.ts';
import { UPDATE_TIMEOUT_MS, type ToolDeps } from '../src/tools.ts';
import { accountId, type Account, type LoginIO, type Provider } from '../src/types.ts';
import { fakeToolDeps, latestVersions, type FakeToolState } from './helpers/tools.ts';

const NOW = new Date('2026-11-18T22:00:00Z');

let dir: string;
let accounts: Account[];
let credentials: Map<string, unknown>;
let stdout: string;
let stderr: string;
let locks: string[];
/** What `<tool> --version` prints; no tool is installed unless a test says so. */
let toolVersions: Record<string, string>;
/** The latest version the registry (or `grok update --check`) reports per tool. */
let latest: { claude?: string; codex?: string; grok?: string };
/** What `<tool> update` does: its result, and the version installed afterwards. */
let toolUpdates: FakeToolState['updates'];
let toolCommands: string[];

const toolDeps = (): ToolDeps =>
  fakeToolDeps({ dir, now: () => NOW, installed: toolVersions, ...latestVersions(latest), updates: toolUpdates, commands: toolCommands, requests: [] });

const fakeProvider: Provider<{ token: string }> = {
  id: 'claude',
  reportsIdentity: true,
  login: async () => ({ credentials: { token: 'new' }, identity: 'me@example.com' }),
  needsRefresh: () => false,
  refresh: async (stored) => stored,
  fetchUsage: async () => ({
    plan: 'max',
    limits: [{ label: '5h', percent: 42, resetsAt: null, severity: 'normal' }],
  }),
};

const ranUpdate = (tool: string) => toolCommands.some((command) => command.startsWith(`${tool} update @`));

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
    color: 'none',
    lock: async (name, fn) => {
      locks.push(name);
      return fn();
    },
    tools: toolDeps(),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-cli-'));
  process.env.AI_USAGE_CONFIG_DIR = dir;
  accounts = [];
  credentials = new Map();
  stdout = '';
  stderr = '';
  locks = [];
  toolVersions = {};
  latest = {};
  toolUpdates = {};
  toolCommands = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('aiu', () => {
  it('prints a hint when no accounts are configured', async () => {
    expect(await main([], deps())).toBe(0);
    expect(stdout).toContain('No accounts yet. Add one with: aiu login <claude|chatgpt|grok> [--name <label>]');
  });

  it('prints the usage table by default', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    credentials.set('claude/personal', { token: 't' });
    expect(await main([], deps())).toBe(0);
    expect(stdout).toContain('personal');
    expect(stdout).toContain(' 42 %');
  });

  it('prints which account to use now above the accounts in burn order', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    credentials.set('claude/personal', { token: 't' });
    const weeklyProvider: Provider<unknown> = {
      ...(fakeProvider as Provider<unknown>),
      fetchUsage: async () => ({
        limits: [{ label: 'Week (all)', kind: 'weekly', percent: 40, resetsAt: new Date(NOW.getTime() + 10 * 3_600_000), severity: 'normal' }],
      }),
    };
    expect(await main([], { ...deps(), providers: { claude: weeklyProvider } })).toBe(0);
    expect(stdout.indexOf('Accounts')).toBeGreaterThan(stdout.indexOf('Use now'));
    expect(stdout).toContain('use personal — 60 % lapses in 10h 0m');
  });

  it('prints valid JSON with --json when no accounts are configured', async () => {
    expect(await main(['--json'], deps())).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      generatedAt: NOW.toISOString(),
      accounts: [],
      recommendation: { providers: [], models: [], plan: [] },
      tools: [],
    });
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

describe('aiu: Tools section', () => {
  beforeEach(() => {
    toolVersions = { claude: '2.1.330 (Claude Code)', grok: 'grok 1.0.89' };
    latest = { claude: '2.1.341', grok: '1.0.89' };
    accounts = [{ provider: 'claude', label: 'personal' }];
    credentials.set('claude/personal', { token: 't' });
  });

  it('ends the default output with the installed tools', async () => {
    expect(await main([], deps())).toBe(0);
    expect(stdout.trimEnd().split('\n').slice(-4)).toEqual([
      '',
      'Tools  installed CLI versions · update with: aiu update',
      '    claude   2.1.330  → 2.1.341',
      '    grok     1.0.89   ✓ latest',
    ]);
  });

  it('leaves the section out when no tool is installed', async () => {
    toolVersions = {};
    expect(await main([], deps())).toBe(0);
    expect(stdout).not.toContain('Tools');
  });

  it('adds the tools to --json', async () => {
    expect(await main(['--json'], deps())).toBe(0);
    expect(JSON.parse(stdout).tools).toEqual([
      { id: 'claude', installed: '2.1.330', latest: '2.1.341', updateAvailable: true },
      { id: 'grok', installed: '1.0.89', latest: '1.0.89', updateAvailable: false },
    ]);
  });

  it('shows the tools even when no account is configured', async () => {
    accounts = [];
    expect(await main([], deps())).toBe(0);
    expect(stdout).toContain('No accounts yet.');
    expect(stdout).toContain('    claude   2.1.330  → 2.1.341');
    stdout = '';
    expect(await main(['--json'], deps())).toBe(0);
    expect(JSON.parse(stdout).tools).toHaveLength(2);
  });

  it('still prints the usage when the version checks blow up', async () => {
    const broken: ToolDeps = {
      ...toolDeps(),
      run: async () => Promise.reject(new Error('spawn failed')),
      cacheDir: () => {
        throw new Error('no home');
      },
    };
    expect(await main([], { ...deps(), tools: broken })).toBe(0);
    expect(stdout).toContain('personal');
    expect(stdout).not.toContain('Tools');
  });

  it('works without a usable cache directory', async () => {
    const uncached: ToolDeps = {
      ...toolDeps(),
      cacheDir: () => {
        throw new Error('no home');
      },
    };
    expect(await main([], { ...deps(), tools: uncached })).toBe(0);
    expect(stdout).toContain('    claude   2.1.330  → 2.1.341');
  });
});

describe('aiu update', () => {
  beforeEach(() => {
    toolVersions = { claude: '2.1.330 (Claude Code)', codex: 'codex-cli 0.171.0' };
    latest = { claude: '2.1.341', codex: '0.171.0', grok: '1.0.92' };
    toolUpdates = { claude: { installs: '2.1.341 (Claude Code)' } };
  });

  it('updates every installed tool and skips the ones that are not installed', async () => {
    expect(await main(['update'], deps())).toBe(0);
    expect(stdout).toBe(
      ['  claude   2.1.330 → 2.1.341   ✓ updated', '  codex    0.171.0             ✓ already latest', ''].join('\n'),
    );
    expect(toolCommands).toContain(`claude update @${UPDATE_TIMEOUT_MS}`);
    expect(ranUpdate('codex')).toBe(false);
  });

  it('updates only the named tools, accepting chatgpt for codex', async () => {
    expect(await main(['update', 'chatgpt', 'codex'], deps())).toBe(0);
    expect(stdout).toBe('  codex    0.171.0             ✓ already latest\n');
    expect(ranUpdate('claude')).toBe(false);
  });

  it('reports a failure, carries on with the other tools and exits 1', async () => {
    toolUpdates = { claude: { result: { code: 1, output: 'network unreachable' } } };
    expect(await main(['update', 'claude', 'codex'], deps())).toBe(1);
    expect(stdout).toContain('  claude   2.1.330             ! failed: network unreachable');
    expect(stdout).toContain('  codex    0.171.0             ✓ already latest');
  });

  it('reports a named tool that is not installed and exits 1', async () => {
    expect(await main(['update', 'grok'], deps())).toBe(1);
    expect(stdout).toBe('  grok                         ! not installed\n');
  });

  it('rejects an unknown tool before running anything', async () => {
    expect(await main(['update', 'claude', 'gemini'], deps())).toBe(2);
    expect(stderr).toContain('Unknown tool: gemini. Use one of: claude, codex, grok');
    expect(toolCommands).toEqual([]);
  });

  it('says so when no tool is installed', async () => {
    toolVersions = {};
    expect(await main(['update'], deps())).toBe(0);
    expect(stdout).toBe('No tools installed.\n');
  });

  it('keeps rejecting extra arguments of other commands', async () => {
    expect(await main(['remove', 'claude/a', 'claude/b'], deps())).toBe(2);
    expect(stderr).toContain('Unexpected argument: claude/b');
  });
});

describe('aiu login', () => {
  it('stores credentials and the account with its identity', async () => {
    expect(await main(['login', 'claude', '--name', 'personal'], deps())).toBe(0);
    expect(credentials.get('claude/personal')).toEqual({ token: 'new' });
    expect(accounts).toEqual([{ provider: 'claude', label: 'personal', identity: 'me@example.com' }]);
    expect(stdout).toContain('Added claude/personal (me@example.com)');
    expect(locks).toEqual(['claude__personal']);
  });

  it('accepts an e-mail address as label', async () => {
    expect(await main(['login', 'claude', '--name', 'ja+ai@pvachek.cz'], deps())).toBe(0);
    expect(credentials.has('claude/ja+ai@pvachek.cz')).toBe(true);
  });

  it('accepts a label of exactly 64 characters', async () => {
    expect(await main(['login', 'claude', '--name', 'a'.repeat(64)], deps())).toBe(0);
  });

  it('removes the new secret when saving the account entry fails', async () => {
    const failingUpsert = async () => {
      throw new Error('disk full');
    };
    expect(await main(['login', 'claude', '--name', 'personal'], { ...deps(), upsertAccount: failingUpsert })).toBe(1);
    expect(credentials.has('claude/personal')).toBe(false);
    expect(stderr).toContain('disk full');
  });

  it('keeps the existing secret of a re-login when saving the account entry fails', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    const failingUpsert = async () => {
      throw new Error('disk full');
    };
    expect(await main(['login', 'claude', '--name', 'personal'], { ...deps(), upsertAccount: failingUpsert })).toBe(1);
    expect(credentials.get('claude/personal')).toEqual({ token: 'new' });
  });

  it('adds a second account with the same e-mail under the label --name gives', async () => {
    accounts = [{ provider: 'claude', label: 'personal', identity: 'me@example.com' }];
    credentials.set('claude/personal', { token: 'old' });
    expect(await main(['login', 'claude', '--name', 'team'], deps())).toBe(0);
    expect(credentials.get('claude/personal')).toEqual({ token: 'old' });
    expect(credentials.get('claude/team')).toEqual({ token: 'new' });
    expect(accounts.map(accountId)).toEqual(['claude/personal', 'claude/team']);
    expect(stdout).toContain('Added claude/team (me@example.com)');
  });

  it.each([['Bad Name'], ['_x'], ['a'.repeat(65)], ['a"b'], ['a/b']])('rejects the label %s', async (label) => {
    expect(await main(['login', 'claude', '--name', label], deps())).toBe(2);
    expect(stderr).toContain('Invalid label');
  });

  it('rejects an empty label and an unknown provider', async () => {
    expect(await main(['login', 'claude', '--name', ''], deps())).toBe(2);
    expect(stderr).toContain('Invalid label');
    expect(await main(['login', 'gemini', '--name', 'x'], deps())).toBe(2);
    expect(stderr).toContain('Unknown provider: gemini');
  });

  describe('without --name', () => {
    const withIdentity = (identity: string | undefined): Partial<CliDeps> => ({
      ...deps(),
      providers: {
        claude: {
          ...fakeProvider,
          login: async () => ({ credentials: { token: 'new' }, ...(identity ? { identity } : {}) }),
        } as Provider<unknown>,
      },
    });

    it('labels the account with its login e-mail', async () => {
      expect(await main(['login', 'claude'], deps())).toBe(0);
      expect(credentials.get('claude/me@example.com')).toEqual({ token: 'new' });
      expect(accounts).toEqual([{ provider: 'claude', label: 'me@example.com', identity: 'me@example.com' }]);
      expect(stdout).toContain('Added claude/me@example.com (me@example.com)');
      expect(locks).toEqual(['claude__me@example.com']);
    });

    it('lowercases the e-mail, since labels are lowercase', async () => {
      expect(await main(['login', 'claude'], withIdentity('Me@Example.com'))).toBe(0);
      expect(accounts).toEqual([{ provider: 'claude', label: 'me@example.com', identity: 'Me@Example.com' }]);
    });

    it('logs in again to the known account with the same e-mail instead of adding a duplicate', async () => {
      accounts = [
        { provider: 'chatgpt', label: 'pro', identity: 'me@example.com' },
        { provider: 'claude', label: 'personal', identity: 'Me@example.com' },
      ];
      expect(await main(['login', 'claude'], deps())).toBe(0);
      expect(credentials.get('claude/personal')).toEqual({ token: 'new' });
      expect(accounts.map(accountId)).toEqual(['chatgpt/pro', 'claude/personal']);
      expect(stdout).toContain('Logged in again to claude/personal (me@example.com)');
      expect(stdout).not.toContain('Added');
    });

    it('asks for --name when several known accounts use the e-mail', async () => {
      accounts = [
        { provider: 'claude', label: 'personal', identity: 'me@example.com' },
        { provider: 'claude', label: 'team', identity: 'me@example.com' },
      ];
      expect(await main(['login', 'claude'], deps())).toBe(2);
      expect(stderr).toContain('Several claude accounts use me@example.com (personal, team); pass --name <label>');
      expect(credentials.size).toBe(0);
    });

    it('asks for --name when the login reports no e-mail', async () => {
      expect(await main(['login', 'claude'], withIdentity(undefined))).toBe(2);
      expect(stderr).toContain('claude did not report the account e-mail; pass --name <label>');
      expect(credentials.size).toBe(0);
      expect(accounts).toEqual([]);
    });

    it('asks for --name when the e-mail is not a valid label', async () => {
      expect(await main(['login', 'claude'], withIdentity(`${'a'.repeat(60)}@example.com`))).toBe(2);
      expect(stderr).toContain('cannot be used as a label; pass --name <label>');
      expect(credentials.size).toBe(0);
    });

    it('asks for --name before logging in to a provider that reports no e-mail', async () => {
      let loggedIn = false;
      const grok = {
        ...fakeProvider,
        id: 'grok',
        reportsIdentity: undefined,
        login: async () => {
          loggedIn = true;
          return { credentials: { token: 'new' } };
        },
      } as Provider<unknown>;
      expect(await main(['login', 'grok'], { ...deps(), providers: { grok } })).toBe(2);
      expect(stderr).toContain('grok does not report the account e-mail; pass --name <label>');
      expect(loggedIn).toBe(false);
    });
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
    expect(locks).toEqual(['claude__personal']);
  });

  it('rejects extra arguments instead of acting on the first ones', async () => {
    accounts = [{ provider: 'claude', label: 'personal' }];
    expect(await main(['remove', 'claude/personal', 'typo'], deps())).toBe(2);
    expect(stderr).toContain('Unexpected argument: typo');
    expect(accounts).toHaveLength(1);
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

  it('reports an id that cannot exist as unknown, without touching the Keychain', async () => {
    let deleted = false;
    const trackingDelete = async () => {
      deleted = true;
    };
    expect(await main(['remove', 'claude/my label'], { ...deps(), deleteCredentials: trackingDelete })).toBe(1);
    expect(stderr).toContain('No such account: claude/my label');
    expect(deleted).toBe(false);
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
