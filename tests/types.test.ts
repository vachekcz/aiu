import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accountId, severityForPercent } from '../src/types.ts';

describe('severityForPercent', () => {
  it('maps thresholds 50 and 80', () => {
    expect(severityForPercent(0)).toBe('normal');
    expect(severityForPercent(49)).toBe('normal');
    expect(severityForPercent(50)).toBe('warning');
    expect(severityForPercent(79)).toBe('warning');
    expect(severityForPercent(80)).toBe('critical');
    expect(severityForPercent(100)).toBe('critical');
  });
});

describe('accountId', () => {
  it('joins provider and label', () => {
    expect(accountId({ provider: 'claude', label: 'work' })).toBe('claude/work');
  });
});

describe('module boundaries', () => {
  const providersDir = fileURLToPath(new URL('../src/providers/', import.meta.url));
  const providerFiles = readdirSync(providersDir).filter((file) => file.endsWith('.ts'));

  it.each(providerFiles)('providers/%s does not import the renderer or the recommendation', (file) => {
    const source = readFileSync(join(providersDir, file), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/(render|recommend)\.ts'/);
  });
});
