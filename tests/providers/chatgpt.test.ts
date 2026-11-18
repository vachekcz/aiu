import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatgptProvider, parseChatGptUsage, windowLabel } from '../../src/providers/chatgpt.ts';
import { AuthExpiredError, type LoginIO } from '../../src/types.ts';
import { httpGet } from '../helpers/http.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/chatgpt-usage.json', import.meta.url), 'utf8'));
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const jwt = (payload: Record<string, unknown>) =>
  ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('windowLabel', () => {
  it('names common window lengths', () => {
    expect(windowLabel(18000)).toBe('5h');
    expect(windowLabel(604800)).toBe('Week');
    expect(windowLabel(86400)).toBe('1d');
    expect(windowLabel(7200)).toBe('2h');
  });
});

describe('parseChatGptUsage', () => {
  it('maps windows and per-model availability', () => {
    expect(parseChatGptUsage(fixture)).toEqual({
      plan: 'pro',
      limits: [
        { label: 'Week', percent: 100, severity: 'critical', resetsAt: new Date(1795205991 * 1000) },
        {
          label: 'gpt-6-astra',
          percent: null,
          severity: 'critical',
          detail: 'blocked',
          resetsAt: new Date('2026-11-20T20:19:52.132766Z'),
        },
      ],
    });
  });

  it('lists the 5h window before the weekly one', () => {
    const { limits } = parseChatGptUsage({
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1 },
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 2 },
      },
    });
    expect(limits.map((limit) => [limit.label, limit.percent])).toEqual([
      ['5h', 20],
      ['Week', 10],
    ]);
  });

  it('marks available models as normal without a reset', () => {
    const { limits } = parseChatGptUsage({ model_usage: { 'gpt-6': { available: true } } });
    expect(limits).toEqual([{ label: 'gpt-6', percent: null, severity: 'normal', detail: 'available', resetsAt: null }]);
  });

  it('renders additional rate limits and skips entries of unexpected shape', () => {
    const { limits } = parseChatGptUsage({
      additional_rate_limits: [
        {
          limit_name: 'GPT-6 Pro',
          rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1 } },
        },
        'junk',
        { limit_name: 'No windows' },
      ],
    });
    expect(limits.map((limit) => limit.label)).toEqual(['GPT-6 Pro Week']);
  });

  it('tolerates empty and null payloads', () => {
    expect(parseChatGptUsage({})).toEqual({ limits: [] });
    expect(parseChatGptUsage(null)).toEqual({ limits: [] });
  });
});

describe('chatgptProvider.login', () => {
  it('runs the browser flow through the localhost:1455 callback', async () => {
    const accessToken = jwt({ exp: 1_800_000_000 });
    const idToken = jwt({
      email: 'me@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' },
    });
    fetchMock.mockResolvedValue(jsonResponse({ access_token: accessToken, refresh_token: 'rt', id_token: idToken }));

    let openedUrl = '';
    const io: LoginIO = {
      print: () => undefined,
      prompt: async () => '',
      openUrl: async (url) => {
        openedUrl = url;
        const state = new URL(url).searchParams.get('state');
        setImmediate(() => void httpGet(`http://localhost:1455/auth/callback?code=c&state=${state}`));
      },
    };

    const result = await chatgptProvider.login(io);

    const authorize = new URL(openedUrl);
    expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    });

    const [tokenUrl, init] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe('https://auth.openai.com/oauth/token');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const form = new URLSearchParams(init.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('c');
    expect(form.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(form.get('client_id')).toBe(CLIENT_ID);
    expect(form.get('code_verifier')).toBeTruthy();

    expect(result).toEqual({
      credentials: { accessToken, refreshToken: 'rt', accountId: 'acc-1', expiresAt: 1_800_000_000_000 },
      identity: 'me@example.com',
    });
  });
});

describe('chatgptProvider.refresh', () => {
  const credentials = { accessToken: 'old', refreshToken: 'old-rt', accountId: 'acc-1', expiresAt: 0 };

  it('posts a JSON refresh_token grant and keeps the account id', async () => {
    const accessToken = jwt({ exp: 1_900_000_000 });
    fetchMock.mockResolvedValue(jsonResponse({ access_token: accessToken, refresh_token: 'new-rt' }));

    const refreshed = await chatgptProvider.refresh(credentials);

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'old-rt',
      scope: 'openid profile email',
    });
    expect(refreshed).toEqual({ accessToken, refreshToken: 'new-rt', accountId: 'acc-1', expiresAt: 1_900_000_000_000 });
  });

  it.each([400, 401])('throws AuthExpiredError on HTTP %i', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, status));
    await expect(chatgptProvider.refresh(credentials)).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

describe('chatgptProvider.fetchUsage', () => {
  const credentials = { accessToken: 'at', refreshToken: 'rt', accountId: 'acc-1', expiresAt: 0 };
  const signal = new AbortController().signal;

  it('sends bearer, account id and user agent headers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(fixture));
    const snapshot = await chatgptProvider.fetchUsage(credentials, signal);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer at',
      'ChatGPT-Account-Id': 'acc-1',
      'User-Agent': 'codex_cli_rs',
    });
    expect(snapshot.plan).toBe('pro');
  });

  it('throws AuthExpiredError on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    await expect(chatgptProvider.fetchUsage(credentials, signal)).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
