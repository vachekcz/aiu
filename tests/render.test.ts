import { describe, expect, it } from 'vitest';
import {
  formatReset,
  renderJson,
  renderTable,
  severityForPercent,
  shouldUseColor,
} from '../src/render.ts';
import type { AccountUsage } from '../src/types.ts';

const now = new Date('2026-11-18T22:00:00Z');
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

const usages: AccountUsage[] = [
  {
    account: { provider: 'claude', label: 'personal' },
    status: 'ok',
    plan: 'max',
    limits: [
      { label: '5h', percent: 80, resetsAt: minutes(80), severity: 'critical' },
      {
        label: 'Week (Fable)',
        percent: 100,
        resetsAt: new Date('2026-11-20T18:00:00Z'),
        severity: 'critical',
      },
    ],
  },
  {
    account: { provider: 'grok', label: 'main' },
    status: 'error',
    message: 'cookie expired',
    hint: 'aiu login grok --name main',
  },
];

describe('severityForPercent', () => {
  it('maps thresholds 50 and 80', () => {
    expect(severityForPercent(49)).toBe('normal');
    expect(severityForPercent(50)).toBe('warning');
    expect(severityForPercent(79)).toBe('warning');
    expect(severityForPercent(80)).toBe('critical');
  });
});

describe('formatReset', () => {
  it('returns empty string for unknown reset', () => {
    expect(formatReset(null, now)).toBe('');
  });
  it('uses minutes under one hour', () => {
    expect(formatReset(minutes(30), now)).toBe('in 30m');
  });
  it('uses hours and minutes under 24 hours', () => {
    expect(formatReset(minutes(72), now)).toBe('in 1h12m');
  });
  it('rounds up, so a reset seconds away is not "in 0m"', () => {
    expect(formatReset(new Date(now.getTime() + 20_000), now)).toBe('in 1m');
  });
  it('says now for a past reset', () => {
    expect(formatReset(minutes(-1), now)).toBe('now');
  });
  it('uses local weekday and time beyond 24 hours', () => {
    expect(formatReset(new Date('2026-11-20T18:00:00Z'), now)).toBe('Fri 19:00');
  });
});

describe('renderTable', () => {
  const output = renderTable(usages, now, { color: false });
  const lines = output.split('\n');

  it('renders bars, percents and resets for ok accounts', () => {
    expect(output).toContain('████████░░');
    expect(output).toContain(' 80 %');
    expect(output).toContain('██████████');
    expect(output).toContain('100 %');
    expect(output).toContain('in 1h20m');
    expect(output).toContain('Fri 19:00');
  });

  it('floors the percent, so a value just under the threshold does not read as 80 %', () => {
    const output = renderTable(
      [{ account: { provider: 'claude', label: 'x' }, status: 'ok', limits: [{ label: '5h', percent: 79.6, resetsAt: null, severity: 'warning' }] }],
      now,
      { color: false },
    );
    expect(output).toContain(' 79 %');
  });

  it('marks critical rows with an exclamation mark', () => {
    const criticalRows = lines.filter((line) => line.includes(' 80 %') || line.includes('100 %'));
    expect(criticalRows).toHaveLength(2);
    criticalRows.forEach((row) => expect(row).toContain('!'));
  });

  it('prints the account id only on its first row', () => {
    expect(lines.filter((line) => line.includes('claude/personal'))).toHaveLength(1);
  });

  it('renders error accounts with message and hint', () => {
    const errorLine = lines.find((line) => line.includes('grok/main'));
    expect(errorLine).toBeDefined();
    expect(output).toContain('cookie expired');
    expect(output).toContain('aiu login grok --name main');
  });

  it('renders detail instead of a bar when percent is unknown', () => {
    const table = renderTable(
      [
        {
          account: { provider: 'chatgpt', label: 'pro' },
          status: 'ok',
          limits: [
            { label: 'gpt-6-astra', percent: null, resetsAt: null, severity: 'critical', detail: 'blocked' },
          ],
        },
      ],
      now,
      { color: false },
    );
    expect(table).toContain('blocked');
    expect(table).not.toContain('░');
  });

  it('emits ANSI codes only when color is enabled', () => {
    expect(output).not.toContain('\x1b[');
    expect(renderTable(usages, now, { color: true })).toContain('\x1b[');
  });
});

describe('shouldUseColor', () => {
  it('requires a TTY and no NO_COLOR', () => {
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
  });
});

describe('renderJson', () => {
  it('serialises accounts with ids, limits and errors', () => {
    expect(JSON.parse(renderJson(usages, now))).toEqual({
      generatedAt: now.toISOString(),
      accounts: [
        {
          id: 'claude/personal',
          provider: 'claude',
          label: 'personal',
          status: 'ok',
          plan: 'max',
          limits: [
            { label: '5h', percent: 80, resetsAt: minutes(80).toISOString(), severity: 'critical' },
            {
              label: 'Week (Fable)',
              percent: 100,
              resetsAt: '2026-11-20T18:00:00.000Z',
              severity: 'critical',
            },
          ],
        },
        {
          id: 'grok/main',
          provider: 'grok',
          label: 'main',
          status: 'error',
          message: 'cookie expired',
          hint: 'aiu login grok --name main',
        },
      ],
    });
  });
});

describe('renderTable edge rows', () => {
  const account = { provider: 'claude' as const, label: 'personal' };

  it('colours a warning limit yellow and a normal one green', () => {
    const output = renderTable(
      [
        {
          account,
          status: 'ok',
          limits: [
            { label: '5h', percent: 60, resetsAt: null, severity: 'warning' },
            { label: 'Week (all)', percent: 10, resetsAt: null, severity: 'normal' },
          ],
        },
      ],
      now,
      { color: true },
    );
    expect(output).toContain('\x1b[33m██████░░░░  60 %');
    expect(output).toContain('\x1b[32m█░░░░░░░░░  10 %');
  });

  it('says so when an ok account reports no limits', () => {
    expect(renderTable([{ account, status: 'ok', limits: [] }], now, { color: false })).toContain('no limits reported');
  });

  it('renders n/a for a limit without percent or detail', () => {
    const output = renderTable(
      [{ account, status: 'ok', limits: [{ label: 'gpt-x', percent: null, resetsAt: null, severity: 'normal' }] }],
      now,
      { color: false },
    );
    expect(output).toContain('gpt-x  n/a');
  });

  it('makes the whole header row bold', () => {
    const header = renderTable([{ account, status: 'ok', limits: [] }], now, { color: true }).split('\n')[0]!;
    expect(header.startsWith('\x1b[1mAccount')).toBe(true);
    expect(header.endsWith('Resets\x1b[0m')).toBe(true);
  });
});
