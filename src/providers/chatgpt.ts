import { waitForOAuthCallback } from '../oauth/callbackServer.ts';
import { createPkce, createState, decodeJwtPayload } from '../oauth/pkce.ts';
import { AuthExpiredError, severityForPercent, type Limit, type LimitKind, type Provider, type UsageSnapshot } from '../types.ts';
import { asArray, asDate, asNumber, asRecord, asString } from './parsing.ts';

// OAuth parameters of the Codex CLI (verified against its binary).
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = 'openid profile email offline_access';
const REFRESH_SCOPE = 'openid profile email';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex_cli_rs';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
const AUTH_CLAIM = 'https://api.openai.com/auth';

export interface ChatGptCredentials {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
}

export function windowLabel(seconds: number): string {
  if (seconds === 604_800) return 'Week';
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** Named extra limits gate one feature or model; plain windows are the short or the weekly allowance. */
function windowKind(seconds: number, prefix?: string): LimitKind {
  if (prefix) return 'model';
  return seconds >= 604_800 ? 'weekly' : 'session';
}

function windowLimit(window: unknown, prefix?: string): { limit: Limit; seconds: number } | null {
  const record = asRecord(window);
  const percent = asNumber(record?.used_percent);
  const seconds = asNumber(record?.limit_window_seconds);
  if (!record || percent === null || seconds === null) return null;
  const resetAt = asNumber(record.reset_at);
  const resetAfter = asNumber(record.reset_after_seconds);
  const resetsAt =
    resetAt !== null ? asDate(resetAt * 1000) : resetAfter !== null ? asDate(Date.now() + resetAfter * 1000) : null;
  const label = prefix ? `${prefix} ${windowLabel(seconds)}` : windowLabel(seconds);
  return { limit: { label, kind: windowKind(seconds, prefix), percent, severity: severityForPercent(percent), resetsAt }, seconds };
}

/** Primary and secondary windows, shorter window first ("5h" before "Week"). */
function rateLimitWindows(rateLimit: unknown, prefix?: string): Limit[] {
  const record = asRecord(rateLimit);
  return [windowLimit(record?.primary_window, prefix), windowLimit(record?.secondary_window, prefix)]
    .filter((window) => window !== null)
    .sort((left, right) => left.seconds - right.seconds)
    .map((window) => window.limit);
}

function additionalLimits(entries: unknown): Limit[] {
  return asArray(entries).flatMap((entry) => {
    const record = asRecord(entry);
    const name = asString(record?.limit_name) ?? asString(record?.metered_feature);
    return record && name ? rateLimitWindows(record.rate_limit, name) : [];
  });
}

function modelLimits(models: unknown): Limit[] {
  const record = asRecord(models);
  if (!record) return [];
  return Object.entries(record).flatMap(([model, value]): Limit[] => {
    const usage = asRecord(value);
    if (!usage || typeof usage.available !== 'boolean') return [];
    return usage.available
      ? [{ label: model, kind: 'model', percent: null, severity: 'normal', detail: 'available', resetsAt: null }]
      : [{ label: model, kind: 'model', percent: null, severity: 'critical', detail: 'blocked', resetsAt: asDate(usage.available_at) }];
  });
}

export function parseChatGptUsage(json: unknown): UsageSnapshot {
  const root = asRecord(json);
  if (!root) return { limits: [] };
  const plan = asString(root.plan_type);
  const limits = [
    ...rateLimitWindows(root.rate_limit),
    ...additionalLimits(root.additional_rate_limits),
    ...modelLimits(root.model_usage),
  ];
  return plan ? { plan, limits } : { limits };
}

async function requestTokens(init: {
  body: string;
  contentType: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    ...(init.signal ? { signal: init.signal } : {}),
    headers: { 'Content-Type': init.contentType },
    body: init.body,
  });
  if (response.status === 400 || response.status === 401) {
    throw new AuthExpiredError(`ChatGPT token request rejected (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`ChatGPT token request HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function jwtExpiry(token: string): number | null {
  try {
    return asNumber(decodeJwtPayload(token).exp);
  } catch {
    return null;
  }
}

function expiresAtFrom(accessToken: string, expiresIn: number | null): number {
  const exp = jwtExpiry(accessToken);
  if (exp !== null) return exp * 1000;
  if (expiresIn !== null) return Date.now() + expiresIn * 1000;
  throw new Error('Cannot determine ChatGPT token expiry');
}

function credentialsFrom(tokens: Record<string, unknown>, previous?: ChatGptCredentials): ChatGptCredentials {
  const accessToken = asString(tokens.access_token);
  const refreshToken = asString(tokens.refresh_token) ?? previous?.refreshToken;
  const idToken = asString(tokens.id_token);
  const claimAccountId = idToken
    ? asString(asRecord(decodeJwtPayload(idToken)[AUTH_CLAIM])?.chatgpt_account_id)
    : null;
  const accountId = claimAccountId ?? previous?.accountId;
  if (!accessToken || !refreshToken || !accountId) throw new Error('Unexpected ChatGPT token response');
  return { accessToken, refreshToken, accountId, expiresAt: expiresAtFrom(accessToken, asNumber(tokens.expires_in)) };
}

export const chatgptProvider: Provider<ChatGptCredentials> = {
  id: 'chatgpt',
  reportsIdentity: true,

  async login(io) {
    const { verifier, challenge } = createPkce();
    const state = createState();
    const url = new URL(`${ISSUER}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: USER_AGENT,
      state,
    }).toString();

    const callback = waitForOAuthCallback({
      port: CALLBACK_PORT,
      path: CALLBACK_PATH,
      expectedState: state,
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    await callback.ready;
    io.print('Sign in with the ChatGPT account you want to add.');
    io.print(`If the browser does not open, visit:\n${url}`);
    await io.openUrl(url.toString());
    const code = await callback.code;

    const tokens = await requestTokens({
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    });
    const idToken = asString(tokens.id_token);
    const identity = idToken ? (asString(decodeJwtPayload(idToken).email) ?? undefined) : undefined;
    return { credentials: credentialsFrom(tokens), ...(identity ? { identity } : {}) };
  },

  needsRefresh(credentials, now) {
    return credentials.expiresAt - REFRESH_MARGIN_MS <= now.getTime();
  },

  async refresh(credentials, signal) {
    const tokens = await requestTokens({
      signal,
      contentType: 'application/json',
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        scope: REFRESH_SCOPE,
      }),
    });
    return credentialsFrom(tokens, credentials);
  },

  async fetchUsage(credentials, signal) {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'ChatGPT-Account-Id': credentials.accountId,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal,
    });
    if (response.status === 401) throw new AuthExpiredError('ChatGPT rejected the access token');
    if (!response.ok) throw new Error(`ChatGPT usage HTTP ${response.status}`);
    return parseChatGptUsage(await response.json());
  },
};
