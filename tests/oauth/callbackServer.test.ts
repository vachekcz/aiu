import { describe, expect, it } from 'vitest';
import { waitForOAuthCallback } from '../../src/oauth/callbackServer.ts';
import { httpGet } from '../helpers/http.ts';

const PORT = 14555;

const options = { port: PORT, path: '/auth/callback', expectedState: 'st', timeoutMs: 5000 };

describe('waitForOAuthCallback', () => {
  it('resolves the code from a callback with the expected state', async () => {
    const callback = waitForOAuthCallback(options);
    await callback.ready;
    expect(await httpGet(`http://localhost:${PORT}/favicon.ico`)).toBe(404);
    expect(await httpGet(`http://localhost:${PORT}/auth/callback?code=c&state=st`)).toBe(200);
    expect(await callback.code).toBe('c');
  });

  it('rejects a callback with a different state', async () => {
    const callback = waitForOAuthCallback(options);
    await callback.ready;
    expect(await httpGet(`http://localhost:${PORT}/auth/callback?code=c&state=other`)).toBe(400);
    await expect(callback.code).rejects.toThrow('OAuth state mismatch');
  });

  it('answers 400 to an unparseable request target and keeps waiting', async () => {
    const callback = waitForOAuthCallback(options);
    await callback.ready;
    expect(await httpGet(`http://localhost:${PORT}//`)).toBe(400);
    expect(await httpGet(`http://localhost:${PORT}/auth/callback?code=c&state=st`)).toBe(200);
    expect(await callback.code).toBe('c');
  });

  it('reports a cancelled consent instead of a state mismatch', async () => {
    const callback = waitForOAuthCallback(options);
    await callback.ready;
    expect(await httpGet(`http://localhost:${PORT}/auth/callback?error=access_denied&state=st`)).toBe(400);
    await expect(callback.code).rejects.toThrow('Login failed: access_denied');
  });

  it('reports a busy port', async () => {
    const first = waitForOAuthCallback(options);
    await first.ready;
    const second = waitForOAuthCallback(options);
    await expect(second.ready).rejects.toThrow(`Port ${PORT} is busy`);
    await httpGet(`http://localhost:${PORT}/auth/callback?code=c&state=st`);
    await first.code;
  });

  it('times out when no callback arrives', async () => {
    const callback = waitForOAuthCallback({ ...options, timeoutMs: 50 });
    await callback.ready;
    await expect(callback.code).rejects.toThrow('Timed out waiting for the browser login');
  });
});
