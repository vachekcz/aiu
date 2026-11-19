import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grokProvider,
  hasActiveSubscription,
  parseGrokCredits,
  parseGrokRateLimits,
  readGrpcWebMessage,
} from '../../src/providers/grok.ts';
import { AuthExpiredError, BlockedError, type LoginIO } from '../../src/types.ts';

const rateLimitsFixture = JSON.parse(readFileSync(new URL('../fixtures/grok-rate-limits.json', import.meta.url), 'utf8'));
const subscriptionsFixture = JSON.parse(
  readFileSync(new URL('../fixtures/grok-subscriptions.json', import.meta.url), 'utf8'),
);
const NOW = new Date('2026-11-19T12:00:00Z');
const PERIOD_END = new Date('2026-11-24T08:00:00Z');
const CREDENTIALS = { cookie: 'sso=abc; sso-rw=def', userAgent: 'Mozilla/5.0 Test' };

// Minimal protobuf / gRPC-web encoders, so the tests state the wire format they rely on.
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}
const varintField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const messageField = (field: number, body: number[]) => [...varint(field * 8 + 2), ...varint(body.length), ...body];
function floatField(field: number, value: number): number[] {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return [...varint(field * 8 + 5), ...buffer];
}
const frame = (flag: number, body: number[]) => [flag, ...[24, 16, 8, 0].map((shift) => (body.length >>> shift) & 0xff), ...body];
const trailer = (text: string) => frame(0x80, [...Buffer.from(text)]);

/** GetGrokCreditsConfig response: field 1 = config {1: used %, 5: {1: period end seconds}, 7: product usage}. */
function creditsConfig(options: { used?: number; periodEnd?: Date } = {}): number[] {
  const config = [
    ...(options.used !== undefined ? floatField(1, options.used) : []),
    ...(options.periodEnd ? messageField(5, varintField(1, options.periodEnd.getTime() / 1000)) : []),
    ...messageField(7, [...varintField(1, 4), ...floatField(2, 30)]),
  ];
  return messageField(1, config);
}

const grpcResponse = (bytes: number[], headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/grpc-web+proto', ...headers },
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const htmlResponse = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });

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

describe('readGrpcWebMessage', () => {
  it('returns the first data frame and skips trailers', () => {
    const bytes = new Uint8Array([...frame(0, [1, 2, 3]), ...trailer('grpc-status:0\r\n')]);
    expect(readGrpcWebMessage(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('turns an UNAUTHENTICATED trailer into AuthExpiredError', () => {
    const bytes = new Uint8Array(trailer('grpc-status:16\r\ngrpc-message:unauthenticated\r\n'));
    expect(() => readGrpcWebMessage(bytes)).toThrow(AuthExpiredError);
  });

  it('reports another gRPC status as an error without a data frame', () => {
    expect(() => readGrpcWebMessage(new Uint8Array(trailer('grpc-status:13\r\n')))).toThrow('gRPC status 13');
    expect(() => readGrpcWebMessage(new Uint8Array())).toThrow('no data');
  });
});

describe('parseGrokCredits', () => {
  const message = (bytes: number[]) => readGrpcWebMessage(new Uint8Array(frame(0, bytes)));

  it('maps the weekly pool to a weekly limit', () => {
    expect(parseGrokCredits(message(creditsConfig({ used: 42.5, periodEnd: PERIOD_END })))).toEqual({
      label: 'Week',
      kind: 'weekly',
      percent: 42.5,
      severity: 'normal',
      resetsAt: PERIOD_END,
    });
  });

  it('reads a missing usage field as 0 % while the rest of the config decodes', () => {
    expect(parseGrokCredits(message(creditsConfig({ periodEnd: PERIOD_END })))?.percent).toBe(0);
  });

  it('clamps the percent and derives severity from it', () => {
    const limit = parseGrokCredits(message(creditsConfig({ used: 130, periodEnd: PERIOD_END })));
    expect(limit).toMatchObject({ percent: 100, severity: 'critical' });
  });

  it('returns null when nothing recognisable is left', () => {
    expect(parseGrokCredits(new Uint8Array())).toBeNull();
    expect(parseGrokCredits(new Uint8Array(messageField(1, varintField(9, 1))))).toBeNull();
  });
});

describe('parseGrokRateLimits', () => {
  it('derives the used percent from remaining and total queries', () => {
    expect(parseGrokRateLimits(rateLimitsFixture)).toEqual({
      label: '2h',
      kind: 'session',
      percent: 25,
      severity: 'normal',
      resetsAt: null,
      detail: '15/20 left',
    });
  });

  it('uses the wait time as the reset when the window is used up', () => {
    const limit = parseGrokRateLimits({ windowSizeSeconds: 7200, remainingQueries: 0, totalQueries: 20, waitTimeSeconds: 600 });
    expect(limit).toMatchObject({ percent: 100, severity: 'critical', resetsAt: new Date(NOW.getTime() + 600_000) });
  });

  it('skips a response without usable counts', () => {
    expect(parseGrokRateLimits({ windowSizeSeconds: 7200 })).toBeNull();
    expect(parseGrokRateLimits({ remainingQueries: 1, totalQueries: 0 })).toBeNull();
    expect(parseGrokRateLimits('nope')).toBeNull();
  });

  it('labels a missing window plainly', () => {
    expect(parseGrokRateLimits({ remainingQueries: 5, totalQueries: 10 })?.label).toBe('Queries');
  });
});

describe('hasActiveSubscription', () => {
  it('finds an active entry among others', () => {
    expect(hasActiveSubscription(subscriptionsFixture)).toBe(true);
    expect(hasActiveSubscription({ subscriptions: [{ status: 'SUBSCRIPTION_STATUS_EXPIRED' }] })).toBe(false);
    expect(hasActiveSubscription({})).toBe(false);
  });
});

describe('grokProvider.fetchUsage', () => {
  const signal = new AbortController().signal;

  it('reads the weekly pool of a paid account with the stored cookie and user agent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(subscriptionsFixture))
      .mockResolvedValueOnce(grpcResponse(frame(0, creditsConfig({ used: 10, periodEnd: PERIOD_END }))));

    const usage = await grokProvider.fetchUsage(CREDENTIALS, signal);

    expect(usage).toEqual({
      limits: [{ label: 'Week', kind: 'weekly', percent: 10, severity: 'normal', resetsAt: PERIOD_END }],
    });
    const [subscriptionsUrl, subscriptionsInit] = fetchMock.mock.calls[0]!;
    expect(subscriptionsUrl).toBe('https://grok.com/rest/subscriptions');
    expect(subscriptionsInit.headers).toMatchObject({ Cookie: CREDENTIALS.cookie, 'User-Agent': CREDENTIALS.userAgent });
    const [creditsUrl, creditsInit] = fetchMock.mock.calls[1]!;
    expect(creditsUrl).toBe('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig');
    expect(creditsInit).toMatchObject({ method: 'POST', signal });
    expect(creditsInit.headers).toMatchObject({ 'Content-Type': 'application/grpc-web+proto', 'X-Grpc-Web': '1' });
    expect(creditsInit.body).toEqual(new Uint8Array(5));
  });

  it('reads the query quota of a free account', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ subscriptions: [] }))
      .mockResolvedValueOnce(jsonResponse(rateLimitsFixture));

    const usage = await grokProvider.fetchUsage(CREDENTIALS, signal);

    expect(usage.limits.map((limit) => [limit.label, limit.percent])).toEqual([['2h', 25]]);
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://grok.com/rest/rate-limits');
    expect(JSON.parse(init.body)).toEqual({ requestKind: 'DEFAULT', modelName: 'grok-3' });
  });

  it('fails loudly when the credits config no longer decodes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(subscriptionsFixture))
      .mockResolvedValueOnce(grpcResponse(frame(0, [])));
    await expect(grokProvider.fetchUsage(CREDENTIALS, signal)).rejects.toThrow('Unexpected Grok usage response');
  });

  it('treats a gRPC UNAUTHENTICATED header as an expired login', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(subscriptionsFixture))
      .mockResolvedValueOnce(grpcResponse([], { 'grpc-status': '16' }));
    await expect(grokProvider.fetchUsage(CREDENTIALS, signal)).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it.each([401, 403])('treats HTTP %i without a challenge as an expired login', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, status));
    await expect(grokProvider.fetchUsage(CREDENTIALS, signal)).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('reports a Cloudflare challenge as blocked', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse('<title>Just a moment...</title><div id="cf-chl-widget">', 403));
    await expect(grokProvider.fetchUsage(CREDENTIALS, signal)).rejects.toBeInstanceOf(BlockedError);
  });

  it('reports other HTTP errors with their status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 502));
    await expect(grokProvider.fetchUsage(CREDENTIALS, signal)).rejects.toThrow('Grok subscriptions HTTP 502');
  });
});

describe('grokProvider login and refresh', () => {
  const fakeIO = (answers: string[]): LoginIO & { questions: string[] } => {
    const questions: string[] = [];
    return {
      questions,
      print: () => undefined,
      openUrl: async () => undefined,
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? '';
      },
    };
  };

  it('asks for the cookie header and the user agent', async () => {
    const io = fakeIO(['  cookie: sso=abc; sso-rw=def  ', ' Mozilla/5.0 Test ']);
    expect(await grokProvider.login(io)).toEqual({ credentials: CREDENTIALS });
    expect(io.questions).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty cookie or user agent', async () => {
    await expect(grokProvider.login(fakeIO(['', 'Mozilla/5.0']))).rejects.toThrow('cookie');
    await expect(grokProvider.login(fakeIO(['sso=abc', '  ']))).rejects.toThrow('user agent');
  });

  it('never refreshes: an expired cookie needs a new login', async () => {
    expect(grokProvider.needsRefresh(CREDENTIALS, NOW)).toBe(false);
    await expect(grokProvider.refresh(CREDENTIALS, new AbortController().signal)).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
