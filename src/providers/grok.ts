import { severityForPercent } from '../render.ts';
import { AuthExpiredError, BlockedError, type Limit, type Provider, type UsageSnapshot } from '../types.ts';
import { windowLabel } from './chatgpt.ts';
import { asArray, asDate, asNumber, asRecord, asString } from './parsing.ts';

// grok.com has no official usage API. These are the endpoints the grok.com web app itself calls;
// paid plans share one weekly pool across Grok products, free accounts keep per-model query quotas.
const ORIGIN = 'https://grok.com';
const SUBSCRIPTIONS_URL = `${ORIGIN}/rest/subscriptions`;
const CREDITS_URL = `${ORIGIN}/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`;
const RATE_LIMITS_URL = `${ORIGIN}/rest/rate-limits`;
const FREE_MODEL = 'grok-3';
const ACTIVE_STATUS = 'SUBSCRIPTION_STATUS_ACTIVE';
const GRPC_UNAUTHENTICATED = '16';

// Fields of the GetGrokCreditsConfig response (protobuf), taken from what the web app reads.
const F_CONFIG = 1;
const F_USED_PERCENT = 1;
const F_PERIOD_END = 5;
const F_PRODUCT_USAGE = 7;
const F_TIMESTAMP_SECONDS = 1;

export interface GrokCredentials {
  /** The whole `cookie` request header of a logged-in grok.com tab. */
  cookie: string;
  /** The browser's user agent; Cloudflare ties its clearance cookie to it. */
  userAgent: string;
}

type ProtoValue = number | Uint8Array;
type ProtoMessage = Map<number, ProtoValue[]>;

/** Decodes the fields this provider needs: varints, 32-bit floats and length-delimited bytes. */
function decodeProtobuf(bytes: Uint8Array): ProtoMessage {
  const fields: ProtoMessage = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    while (offset < bytes.length) {
      const byte = bytes[offset++]!;
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 128;
    }
    throw new Error('Truncated varint');
  };
  const add = (field: number, value: ProtoValue) => fields.set(field, [...(fields.get(field) ?? []), value]);

  try {
    while (offset < bytes.length) {
      const key = readVarint();
      const field = Math.floor(key / 8);
      const wireType = key % 8;
      if (field === 0) break;
      if (wireType === 0) add(field, readVarint());
      else if (wireType === 1) offset += 8;
      else if (wireType === 2) {
        const length = readVarint();
        if (offset + length > bytes.length) break;
        add(field, bytes.subarray(offset, offset + length));
        offset += length;
      } else if (wireType === 5) {
        if (offset + 4 > bytes.length) break;
        add(field, view.getFloat32(offset, true));
        offset += 4;
      } else break;
    }
  } catch {
    // A truncated tail keeps the fields decoded so far.
  }
  return fields;
}

const firstNumber = (message: ProtoMessage, field: number): number | null => {
  const value = message.get(field)?.[0];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const firstBytes = (message: ProtoMessage, field: number): Uint8Array | null => {
  const value = message.get(field)?.[0];
  return value instanceof Uint8Array ? value : null;
};

function parseTrailers(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(bytes);
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.split(':'))
      .filter((parts) => parts.length >= 2)
      .map(([name, ...value]) => [name!.trim().toLowerCase(), value.join(':').trim()]),
  );
}

function grpcStatusError(status: string): Error {
  return status === GRPC_UNAUTHENTICATED
    ? new AuthExpiredError('Grok rejected the cookie')
    : new Error(`Grok usage gRPC status ${status}`);
}

/** The first data frame of a gRPC-web response body; a trailer-only body carries the error status. */
export function readGrpcWebMessage(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let trailers: Record<string, string> = {};
  for (let offset = 0; offset + 5 <= bytes.length; ) {
    const flag = bytes[offset]!;
    const length = view.getUint32(offset + 1, false);
    const body = bytes.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    if ((flag & 0x80) === 0) return body;
    trailers = { ...trailers, ...parseTrailers(body) };
  }
  const status = trailers['grpc-status'];
  if (status && status !== '0') throw grpcStatusError(status);
  throw new Error('Grok usage response has no data');
}

/** The weekly usage pool of a paid plan, or null when the response no longer has a known shape. */
export function parseGrokCredits(message: Uint8Array): Limit | null {
  const configBytes = firstBytes(decodeProtobuf(message), F_CONFIG);
  if (!configBytes) return null;
  const config = decodeProtobuf(configBytes);
  const periodEnd = firstBytes(config, F_PERIOD_END);
  const seconds = periodEnd ? firstNumber(decodeProtobuf(periodEnd), F_TIMESTAMP_SECONDS) : null;
  const resetsAt = seconds !== null && seconds > 0 ? asDate(seconds * 1000) : null;
  const used = firstNumber(config, F_USED_PERCENT);
  // proto3 omits zero values, so a missing percent is a real 0 % - but only while the rest still decodes.
  if (used === null && resetsAt === null && !config.has(F_PRODUCT_USAGE)) return null;
  const percent = Math.min(100, Math.max(0, used ?? 0));
  return { label: 'Week', kind: 'weekly', percent, severity: severityForPercent(percent), resetsAt };
}

/**
 * The query quota of a free account. remainingQueries/totalQueries are what the web app reads;
 * windowSizeSeconds and waitTimeSeconds were only reported by users of a grok.com userscript and
 * may be missing, so the label falls back to "Queries" and the reset to unknown.
 */
export function parseGrokRateLimits(json: unknown): Limit | null {
  const root = asRecord(json);
  const total = asNumber(root?.totalQueries);
  const remaining = asNumber(root?.remainingQueries);
  if (!root || total === null || remaining === null || total <= 0) return null;
  const seconds = asNumber(root.windowSizeSeconds);
  const wait = asNumber(root.waitTimeSeconds);
  const percent = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
  return {
    label: seconds !== null && seconds > 0 ? windowLabel(seconds) : 'Queries',
    kind: seconds !== null && seconds >= 604_800 ? 'weekly' : 'session',
    percent,
    severity: severityForPercent(percent),
    resetsAt: wait !== null && wait > 0 ? new Date(Date.now() + wait * 1000) : null,
    detail: `${remaining}/${total} left`,
  };
}

export function hasActiveSubscription(json: unknown): boolean {
  return asArray(asRecord(json)?.subscriptions).some((entry) => asString(asRecord(entry)?.status) === ACTIVE_STATUS);
}

/**
 * grok.com reports its own errors as JSON ({"code":16,...}); an HTML error page comes from Cloudflare
 * (challenge or WAF block), which a new cookie would not fix.
 */
function checkResponse(response: Response, what: string): void {
  if (response.ok) return;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html') || response.headers.has('cf-mitigated')) {
    throw new BlockedError(`Grok ${what} blocked by Cloudflare (HTTP ${response.status})`);
  }
  if (response.status === 401 || response.status === 403) throw new AuthExpiredError('Grok rejected the cookie');
  throw new Error(`Grok ${what} HTTP ${response.status}`);
}

function headers(credentials: GrokCredentials, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Cookie: credentials.cookie,
    'User-Agent': credentials.userAgent,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    ...extra,
  };
}

async function fetchCredits(credentials: GrokCredentials, signal: AbortSignal): Promise<Limit> {
  const response = await fetch(CREDITS_URL, {
    method: 'POST',
    headers: headers(credentials, { 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' }),
    // One empty gRPC-web frame: flag 0, length 0.
    body: new Uint8Array(5),
    signal,
  });
  checkResponse(response, 'usage');
  const status = response.headers.get('grpc-status');
  if (status && status !== '0') throw grpcStatusError(status);
  const limit = parseGrokCredits(readGrpcWebMessage(new Uint8Array(await response.arrayBuffer())));
  if (!limit) throw new Error('Unexpected Grok usage response');
  return limit;
}

async function fetchRateLimits(credentials: GrokCredentials, signal: AbortSignal): Promise<Limit[]> {
  const response = await fetch(RATE_LIMITS_URL, {
    method: 'POST',
    headers: headers(credentials, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ requestKind: 'DEFAULT', modelName: FREE_MODEL }),
    signal,
  });
  checkResponse(response, 'rate limits');
  const limit = parseGrokRateLimits(await response.json());
  return limit ? [limit] : [];
}

/** Accepts the header value with or without its "cookie:" name, as DevTools copies either. */
function normaliseCookie(input: string): string {
  return input.trim().replace(/^cookie:\s*/i, '');
}

export const grokProvider: Provider<GrokCredentials> = {
  id: 'grok',

  async login(io) {
    io.print('Grok has no login API, so aiu uses the session of a logged-in grok.com tab:');
    io.print('  1. Open https://grok.com with the account you want to add.');
    io.print('  2. DevTools (Cmd+Opt+I) → Network → reload → click any grok.com/rest/... request.');
    io.print('  3. Under Request Headers, copy the value of "cookie".');
    io.print('  4. In the Console, run navigator.userAgent and copy the result.');
    io.print('The cookie is stored only in macOS Keychain. When it expires, run this login again.');
    const cookie = normaliseCookie(await io.prompt('Paste the cookie header (input hidden): ', { secret: true }));
    if (!cookie || /[\r\n]/.test(cookie)) throw new Error('Paste the cookie header value on one line');
    const userAgent = (await io.prompt('Paste the user agent: ')).trim();
    if (!userAgent || /[\r\n]/.test(userAgent)) throw new Error('Paste the user agent on one line');
    return { credentials: { cookie, userAgent } };
  },

  needsRefresh() {
    return false;
  },

  async refresh() {
    throw new AuthExpiredError('Grok cookies cannot be refreshed');
  },

  async fetchUsage(credentials, signal): Promise<UsageSnapshot> {
    const response = await fetch(SUBSCRIPTIONS_URL, { headers: headers(credentials), signal });
    checkResponse(response, 'subscriptions');
    const limits = hasActiveSubscription(await response.json())
      ? [await fetchCredits(credentials, signal)]
      : await fetchRateLimits(credentials, signal);
    return { limits };
  },
};
