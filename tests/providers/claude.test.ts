import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeAuthorizeUrl, claudeProvider, parseClaudeUsage } from '../../src/providers/claude.ts';
import { AuthExpiredError, type LoginIO } from '../../src/types.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/claude-usage.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-18T22:00:00Z');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseClaudeUsage', () => {
  it('maps the limits array to labelled limits', () => {
    expect(parseClaudeUsage(fixture).limits).toEqual([
      { label: '5h', percent: 80, severity: 'warning', resetsAt: new Date('2026-11-18T23:20:00Z') },
      { label: 'Week (all)', percent: 70, severity: 'normal', resetsAt: new Date('2026-11-20T18:00:00Z') },
      { label: 'Week (Fable)', percent: 100, severity: 'critical', resetsAt: new Date('2026-11-20T18:00:00Z') },
    ]);
  });

  it('labels unknown kinds by kind and derives severity from percent when missing', () => {
    const { limits } = parseClaudeUsage({ limits: [{ kind: 'monthly_x', percent: 85 }] });
    expect(limits).toEqual([{ label: 'monthly_x', percent: 85, severity: 'critical', resetsAt: null }]);
  });

  it('ignores an unknown severity value', () => {
    const { limits } = parseClaudeUsage({ limits: [{ kind: 'session', percent: 10, severity: 'purple' }] });
    expect(limits[0]?.severity).toBe('normal');
  });

  it('falls back to legacy five_hour / seven_day fields without a limits array', () => {
    const { limits } = parseClaudeUsage({ five_hour: fixture.five_hour, seven_day: fixture.seven_day, limits: null });
    expect(limits.map((limit) => [limit.label, limit.percent])).toEqual([
      ['5h', 80],
      ['Week (all)', 70],
    ]);
  });

  it('tolerates empty and null payloads', () => {
    expect(parseClaudeUsage({})).toEqual({ limits: [] });
    expect(parseClaudeUsage(null)).toEqual({ limits: [] });
  });

  it('skips entries without a numeric percent', () => {
    expect(parseClaudeUsage({ limits: [{ kind: 'session' }, 'junk'] })).toEqual({ limits: [] });
  });
});

describe('buildClaudeAuthorizeUrl', () => {
  it('builds the Claude Code compatible authorize URL', () => {
    const url = new URL(buildClaudeAuthorizeUrl('ch', 'st'));
    expect(url.origin + url.pathname).toBe('https://claude.com/cai/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: 'true',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      response_type: 'code',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      scope: 'user:profile',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
    });
  });
});

function fakeIO(pasted: (state: string) => string): LoginIO & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    print: () => undefined,
    openUrl: async (url) => {
      opened.push(url);
    },
    prompt: async () => pasted(new URL(opened[0] ?? 'http://x').searchParams.get('state') ?? ''),
  };
}

describe('claudeProvider.login', () => {
  it('exchanges the pasted code for tokens', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 28800,
        account: { email_address: 'me@example.com' },
      }),
    );
    const io = fakeIO((state) => `thecode#${state}`);

    const result = await claudeProvider.login(io);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    const body = JSON.parse(init.body);
    const authorizeParams = new URL(io.opened[0]!).searchParams;
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'thecode',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      state: authorizeParams.get('state'),
    });
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
      authorizeParams.get('code_challenge'),
    );
    expect(result).toEqual({
      credentials: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW.getTime() + 28800 * 1000 },
      identity: 'me@example.com',
    });
  });

  it('rejects a pasted code with a different state', async () => {
    await expect(claudeProvider.login(fakeIO(() => 'thecode#other'))).rejects.toThrow('OAuth state mismatch');
  });

  it('asks for the whole pasted code when the state part is missing', async () => {
    await expect(claudeProvider.login(fakeIO(() => 'thecode'))).rejects.toThrow('including the part after "#"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('claudeProvider.refresh', () => {
  const credentials = { accessToken: 'old', refreshToken: 'old-rt', expiresAt: 0 };

  it('posts a refresh_token grant and keeps the old refresh token when none is returned', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'new', expires_in: 3600 }));
    const signal = new AbortController().signal;
    const refreshed = await claudeProvider.refresh(credentials, signal);
    expect(fetchMock.mock.calls[0]![1].signal).toBe(signal);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-rt',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    // No scope: the server then keeps what the login granted. Asking for more fails with invalid_scope.
    expect(body).not.toHaveProperty('scope');
    expect(refreshed).toEqual({ accessToken: 'new', refreshToken: 'old-rt', expiresAt: NOW.getTime() + 3600_000 });
  });

  it.each([400, 401])('throws AuthExpiredError on HTTP %i', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, status));
    await expect(claudeProvider.refresh(credentials, new AbortController().signal)).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

describe('claudeProvider.needsRefresh', () => {
  it('refreshes one minute before expiry', () => {
    const base = { accessToken: 'a', refreshToken: 'r' };
    expect(claudeProvider.needsRefresh({ ...base, expiresAt: NOW.getTime() + 60_000 }, NOW)).toBe(true);
    expect(claudeProvider.needsRefresh({ ...base, expiresAt: NOW.getTime() + 61_000 }, NOW)).toBe(false);
  });
});

describe('claudeProvider.fetchUsage', () => {
  const credentials = { accessToken: 'at', refreshToken: 'rt', expiresAt: 0 };
  const signal = new AbortController().signal;

  it('sends the bearer token and beta header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(fixture));
    const snapshot = await claudeProvider.fetchUsage(credentials, signal);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer at', 'anthropic-beta': 'oauth-2025-04-20' });
    expect(snapshot.limits).toHaveLength(3);
  });

  it('throws AuthExpiredError on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    await expect(claudeProvider.fetchUsage(credentials, signal)).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws a descriptive error on other HTTP failures', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    await expect(claudeProvider.fetchUsage(credentials, signal)).rejects.toThrow('Claude usage HTTP 500');
  });
});
