import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPkce, createState, decodeJwtPayload } from '../../src/oauth/pkce.ts';

describe('pkce', () => {
  it('derives the challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('creates distinct states', () => {
    expect(createState()).not.toBe(createState());
  });

  it('decodes a JWT payload', () => {
    const payload = { email: 'me@example.com', exp: 123 };
    const token = ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
    expect(decodeJwtPayload(token)).toEqual(payload);
  });
});
