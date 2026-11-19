import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectUsage, type CollectDeps } from '../src/collect.ts';
import { withFileLock } from '../src/lock.ts';
import { AuthExpiredError, BlockedError, type Account, type Provider } from '../src/types.ts';

interface FakeCredentials {
  token: string;
  expiresAt: number;
}

const NOW = new Date('2026-11-18T22:00:00Z');
const FRESH = NOW.getTime() + 3_600_000;
const EXPIRED = NOW.getTime() - 1;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const claudePersonal: Account = { provider: 'claude', label: 'personal' };
const chatgptPro: Account = { provider: 'chatgpt', label: 'pro' };

interface FakeProvider extends Provider<FakeCredentials> {
  refreshCalls: number;
  refreshSignals: AbortSignal[];
  fetchTokens: string[];
  fetchStarts: number[];
}

function fakeProvider(options: {
  fetch?: (credentials: FakeCredentials, call: number) => Promise<unknown>;
  refresh?: (credentials: FakeCredentials) => Promise<FakeCredentials>;
} = {}): FakeProvider {
  const provider: FakeProvider = {
    id: 'claude',
    refreshCalls: 0,
    refreshSignals: [],
    fetchTokens: [],
    fetchStarts: [],
    login: async () => ({ credentials: { token: 'x', expiresAt: FRESH } }),
    needsRefresh: (credentials, now) => credentials.expiresAt <= now.getTime(),
    refresh: async (credentials, signal) => {
      provider.refreshCalls++;
      provider.refreshSignals.push(signal);
      await sleep(20);
      return options.refresh ? options.refresh(credentials) : { token: `refreshed-${provider.refreshCalls}`, expiresAt: FRESH };
    },
    fetchUsage: async (credentials) => {
      provider.fetchTokens.push(credentials.token);
      provider.fetchStarts.push(Date.now());
      await options.fetch?.(credentials, provider.fetchTokens.length);
      return { plan: 'max', limits: [{ label: '5h', percent: 10, resetsAt: null, severity: 'normal' }] };
    },
  };
  return provider;
}

let dir: string;
let store: Map<string, unknown>;
let saves: string[];

function deps(providers: CollectDeps['providers'], overrides: Partial<CollectDeps> = {}): CollectDeps {
  return {
    providers,
    loadCredentials: async (id) => store.get(id) ?? null,
    saveCredentials: async (id, credentials) => {
      saves.push(`${id}:${(credentials as FakeCredentials).token}`);
      store.set(id, credentials);
    },
    now: () => NOW,
    timeoutMs: 1000,
    refreshTimeoutMs: 3000,
    lock: withFileLock,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-collect-'));
  process.env.AI_USAGE_CONFIG_DIR = dir;
  store = new Map();
  saves = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('collectUsage', () => {
  it('fetches accounts in parallel and keeps input order', async () => {
    const provider = fakeProvider({ fetch: () => sleep(50) });
    store.set('claude/personal', { token: 'a', expiresAt: FRESH });
    store.set('chatgpt/pro', { token: 'b', expiresAt: FRESH });

    const result = await collectUsage([claudePersonal, chatgptPro], deps({ claude: provider, chatgpt: provider }));

    // Overlap, not wall-clock: the second fetch starts before the first one's 50 ms sleep ends.
    const [first, second] = [...provider.fetchStarts].sort((a, b) => a - b);
    expect(second! - first!).toBeLessThan(50);
    expect(result.map((usage) => [usage.account.label, usage.status])).toEqual([
      ['personal', 'ok'],
      ['pro', 'ok'],
    ]);
  });

  it('refreshes expired credentials and saves them before fetching', async () => {
    const provider = fakeProvider();
    store.set('claude/personal', { token: 'old', expiresAt: EXPIRED });

    const [usage] = await collectUsage([claudePersonal], deps({ claude: provider }));

    expect(provider.refreshCalls).toBe(1);
    expect(provider.refreshSignals[0]).toBeInstanceOf(AbortSignal);
    expect(saves).toEqual(['claude/personal:refreshed-1']);
    expect(provider.fetchTokens).toEqual(['refreshed-1']);
    expect(usage).toMatchObject({ status: 'ok', plan: 'max' });
  });

  it('refreshes once and retries when a fresh token is rejected', async () => {
    const provider = fakeProvider({
      fetch: async (_credentials, call) => {
        if (call === 1) throw new AuthExpiredError('401');
      },
    });
    store.set('claude/personal', { token: 'a', expiresAt: FRESH });

    const [usage] = await collectUsage([claudePersonal], deps({ claude: provider }));

    expect(provider.fetchTokens).toEqual(['a', 'refreshed-1']);
    expect(usage?.status).toBe('ok');
  });

  it('gives up after the retried fetch is rejected again', async () => {
    const provider = fakeProvider({
      fetch: async () => {
        throw new AuthExpiredError('401');
      },
    });
    store.set('claude/personal', { token: 'a', expiresAt: FRESH });

    const [usage] = await collectUsage([claudePersonal], deps({ claude: provider }));

    expect(provider.fetchTokens).toHaveLength(2);
    expect(provider.refreshCalls).toBe(1);
    expect(usage).toEqual({
      account: claudePersonal,
      status: 'error',
      message: 'Login expired',
      hint: 'aiu login claude --name personal',
    });
  });

  it('reports a rejected refresh token without affecting other accounts', async () => {
    const broken = fakeProvider({
      refresh: async () => {
        throw new AuthExpiredError('invalid_grant');
      },
    });
    const healthy = fakeProvider();
    store.set('claude/personal', { token: 'a', expiresAt: EXPIRED });
    store.set('chatgpt/pro', { token: 'b', expiresAt: FRESH });

    const result = await collectUsage([claudePersonal, chatgptPro], deps({ claude: broken, chatgpt: healthy }));

    expect(result[0]).toMatchObject({ status: 'error', message: 'Login expired', hint: 'aiu login claude --name personal' });
    expect(result[1]?.status).toBe('ok');
  });

  it('reports missing credentials with a login hint', async () => {
    const [usage] = await collectUsage([chatgptPro], deps({ chatgpt: fakeProvider() }));
    expect(usage).toMatchObject({ status: 'error', message: 'No credentials stored', hint: 'aiu login chatgpt --name pro' });
  });

  it('maps blocked, hanging and unknown providers to error rows', async () => {
    const grok: Account = { provider: 'grok', label: 'main' };
    store.set('claude/personal', { token: 'a', expiresAt: FRESH });
    store.set('chatgpt/pro', { token: 'b', expiresAt: FRESH });
    store.set('grok/main', { token: 'c', expiresAt: FRESH });
    const blocked = fakeProvider({
      fetch: async () => {
        throw new BlockedError('cloudflare');
      },
    });
    const hanging = fakeProvider({ fetch: () => new Promise(() => undefined) });

    const result = await collectUsage(
      [claudePersonal, chatgptPro, grok],
      deps({ claude: blocked, chatgpt: hanging }, { timeoutMs: 100 }),
    );

    expect(result.map((usage) => (usage.status === 'error' ? usage.message : 'ok'))).toEqual([
      'Unavailable (blocked)',
      'Timed out',
      'Unknown provider',
    ]);
  });

  it('refreshes only once when two runs race on the same expired account', async () => {
    const provider = fakeProvider();
    store.set('claude/personal', { token: 'old', expiresAt: EXPIRED });

    const [first, second] = await Promise.all([
      collectUsage([claudePersonal], deps({ claude: provider })),
      collectUsage([claudePersonal], deps({ claude: provider })),
    ]);

    expect(provider.refreshCalls).toBe(1);
    expect(provider.fetchTokens).toEqual(['refreshed-1', 'refreshed-1']);
    expect(first[0]?.status).toBe('ok');
    expect(second[0]?.status).toBe('ok');
  });
});
