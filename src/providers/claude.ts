import { createPkce, createState } from '../oauth/pkce.ts';
import { severityForPercent } from '../render.ts';
import { AuthExpiredError, type Limit, type LimitKind, type Provider, type Severity, type UsageSnapshot } from '../types.ts';
import { asArray, asDate, asNumber, asRecord, asString } from './parsing.ts';

// OAuth parameters of Claude Code (verified against Claude Code 2.1.327).
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// The usage endpoint needs only user:profile. Requesting user:inference would let the token run
// models and makes claude.ai require a personal Pro/Max/Ultra plan before it grants the login.
const SCOPES = ['user:profile'];
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const REFRESH_MARGIN_MS = 60_000;

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
}

const SEVERITIES: readonly Severity[] = ['normal', 'warning', 'critical'];

const KINDS: Record<string, LimitKind> = { session: 'session', weekly_all: 'weekly', weekly_scoped: 'model' };

/** Fallback for kinds this version does not know: the coarser group still says what the limit gates. */
function kindFromGroup(group: string | null, scope: unknown): LimitKind | undefined {
  if (group === 'session') return 'session';
  if (group === 'weekly') return asRecord(scope) ? 'model' : 'weekly';
  return undefined;
}

function labelFor(kind: string, scope: unknown): string {
  if (kind === 'session') return '5h';
  if (kind === 'weekly_all') return 'Week (all)';
  if (kind === 'weekly_scoped') {
    const model = asString(asRecord(asRecord(asRecord(scope)?.model))?.display_name);
    return model ? `Week (${model})` : 'Week (scoped)';
  }
  return kind;
}

function limitFromEntry(entry: unknown): Limit | null {
  const record = asRecord(entry);
  const percent = asNumber(record?.percent);
  if (!record || percent === null) return null;
  const severity = asString(record.severity);
  const rawKind = asString(record.kind) ?? '';
  const kind = Object.hasOwn(KINDS, rawKind) ? KINDS[rawKind] : kindFromGroup(asString(record.group), record.scope);
  return {
    label: labelFor(asString(record.kind) ?? 'limit', record.scope),
    ...(kind ? { kind } : {}),
    percent,
    severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : severityForPercent(percent),
    resetsAt: asDate(record.resets_at),
  };
}

function legacyLimit(label: string, kind: LimitKind, window: unknown): Limit | null {
  const record = asRecord(window);
  const percent = asNumber(record?.utilization);
  if (percent === null) return null;
  return { label, kind, percent, severity: severityForPercent(percent), resetsAt: asDate(record?.resets_at) };
}

export function parseClaudeUsage(json: unknown): UsageSnapshot {
  const root = asRecord(json);
  if (!root) return { limits: [] };
  if (Array.isArray(root.limits)) {
    return { limits: asArray(root.limits).map(limitFromEntry).filter((limit) => limit !== null) };
  }
  const legacy = [legacyLimit('5h', 'session', root.five_hour), legacyLimit('Week (all)', 'weekly', root.seven_day)];
  return { limits: legacy.filter((limit) => limit !== null) };
}

export function buildClaudeAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return url.toString();
}

async function requestTokens(body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 400 || response.status === 401) {
    throw new AuthExpiredError(`Claude token request rejected (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`Claude token request HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function credentialsFrom(tokens: Record<string, unknown>, previousRefreshToken?: string): ClaudeCredentials {
  const accessToken = asString(tokens.access_token);
  const refreshToken = asString(tokens.refresh_token) ?? previousRefreshToken;
  const expiresIn = asNumber(tokens.expires_in);
  if (!accessToken || !refreshToken || expiresIn === null) throw new Error('Unexpected Claude token response');
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export const claudeProvider: Provider<ClaudeCredentials> = {
  id: 'claude',

  async login(io) {
    const { verifier, challenge } = createPkce();
    const state = createState();
    io.print('Sign in with the Claude account you want to add.');
    io.print('Tip: to add a different account, switch accounts on claude.ai first or use a private window.');
    const url = buildClaudeAuthorizeUrl(challenge, state);
    io.print(`If the browser does not open, visit:\n${url}`);
    await io.openUrl(url);

    const pasted = (await io.prompt('Paste the code shown after login: ')).trim();
    const [code, returnedState] = pasted.split('#');
    if (!code || !returnedState) throw new Error('Paste the whole code shown after login, including the part after "#"');
    if (returnedState !== state) throw new Error('OAuth state mismatch');

    const tokens = await requestTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    });
    const identity = asString(asRecord(tokens.account)?.email_address) ?? undefined;
    return { credentials: credentialsFrom(tokens), ...(identity ? { identity } : {}) };
  },

  needsRefresh(credentials, now) {
    return credentials.expiresAt - REFRESH_MARGIN_MS <= now.getTime();
  },

  async refresh(credentials, signal) {
    const tokens = await requestTokens(
      // No scope: the server keeps what the login granted, so a later change of SCOPES
      // cannot break existing logins with invalid_scope.
      { grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: CLIENT_ID },
      signal,
    );
    return credentialsFrom(tokens, credentials.refreshToken);
  },

  async fetchUsage(credentials, signal) {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json',
      },
      signal,
    });
    if (response.status === 401) throw new AuthExpiredError('Claude rejected the access token');
    if (!response.ok) throw new Error(`Claude usage HTTP ${response.status}`);
    return parseClaudeUsage(await response.json());
  },
};
