import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/store/keychain.ts', () => ({
  readSecret: async () => '{"accessToken": "trunc',
  writeSecret: async () => undefined,
  deleteSecret: async () => undefined,
}));

const { loadCredentials } = await import('../../src/store/credentials.ts');

describe('loadCredentials', () => {
  it('names the account and the fix when the stored value is not valid JSON', async () => {
    await expect(loadCredentials('claude/personal')).rejects.toThrow(
      'Stored login for claude/personal is corrupted; run: aiu login claude --name personal',
    );
  });
});
