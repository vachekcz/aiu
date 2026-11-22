import { describe, expect, it } from 'vitest';
import { stubFetch } from './fetch.ts';
import { loadFixture } from './fixtures.ts';
import { jsonResponse } from './http.ts';

const NOW = new Date('2026-11-18T22:00:00Z');
const realFetch = globalThis.fetch;
const fetchMock = stubFetch({ now: NOW });

describe('stubFetch', () => {
  it('replaces the global fetch and freezes the clock', async () => {
    expect(globalThis.fetch).toBe(fetchMock);
    expect(globalThis.fetch).not.toBe(realFetch);
    expect(new Date()).toEqual(NOW);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    expect(await (await fetch('https://example.com')).json()).toEqual({ ok: true });
  });

  it('starts every test without calls or prepared answers', async () => {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetch('https://example.com')).toBeUndefined();
  });
});

describe('jsonResponse', () => {
  it('builds a JSON response with the given status', async () => {
    const response = jsonResponse({ error: 'nope' }, 401);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'nope' });
  });
});

describe('loadFixture', () => {
  it('reads a recorded response by name', () => {
    expect(loadFixture('grok-rate-limits')).toMatchObject({ windowSizeSeconds: 7200 });
  });
});
