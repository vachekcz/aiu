import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatReset,
  renderRecommendation,
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
      { label: '5h', kind: 'session', percent: 80, resetsAt: minutes(80), severity: 'critical' },
      {
        label: 'Week (Fable)',
        kind: 'model',
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
    expect(formatReset(null)).toBe('');
  });
  it('uses local weekday and time, also for a reset within the hour', () => {
    expect(formatReset(new Date('2026-11-20T18:00:00Z'))).toBe('Fri 19:00');
    expect(formatReset(minutes(30))).toBe('Wed 23:30');
  });
});

describe('formatCountdown', () => {
  it('returns empty string for unknown reset', () => {
    expect(formatCountdown(null, now)).toBe('');
  });
  it('uses minutes under one hour', () => {
    expect(formatCountdown(minutes(30), now)).toBe('30m');
  });
  it('uses hours and minutes under one day', () => {
    expect(formatCountdown(minutes(72), now)).toBe('1h 12m');
  });
  it('uses days and hours from one day on', () => {
    expect(formatCountdown(minutes(2 * 24 * 60 + 2 * 60 + 30), now)).toBe('2d 2h');
    expect(formatCountdown(minutes(24 * 60), now)).toBe('1d 0h');
  });
  it('rounds up, so a reset seconds away is not "0m"', () => {
    expect(formatCountdown(new Date(now.getTime() + 20_000), now)).toBe('1m');
  });
  it('says now for a past reset', () => {
    expect(formatCountdown(minutes(-1), now)).toBe('now');
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
    expect(output).toContain('1h 20m');
    expect(output).toContain('1d 20h');
    expect(output).toContain('Fri 19:00');
  });

  it('shows the countdown and the reset time in separate columns', () => {
    expect(lines[0]).toMatch(/Used\s+Resets in\s+Resets at$/);
    const fiveHour = lines.find((line) => line.includes(' 80 %'))!;
    expect(fiveHour).toMatch(/1h 20m\s+Thu 00:20$/);
  });

  it('separates accounts with a blank line', () => {
    expect(lines).toContain('');
    const blank = lines.indexOf('');
    expect(lines[blank + 1]).toContain('grok/main');
    expect(lines[blank - 1]).toContain('Week (Fable)');
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
            { label: '5h', kind: 'session', percent: 80, resetsAt: minutes(80).toISOString(), severity: 'critical' },
            {
              label: 'Week (Fable)',
              kind: 'model',
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
      recommendation: {
        providers: [{ provider: 'claude', accountId: 'claude/personal', sessionLeft: 20 }],
        models: [
          {
            provider: 'claude',
            label: 'Week (Fable)',
            availableOn: [],
            availableAt: '2026-11-20T18:00:00.000Z',
            availableAccountId: 'claude/personal',
          },
        ],
      },
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
    expect(header.endsWith('Resets at\x1b[0m')).toBe(true);
  });
});

describe('renderRecommendation', () => {
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
  const claudeAccount = (label: string, session: number, weekly: number, weeklyIn: number, fable: number): AccountUsage => ({
    account: { provider: 'claude', label },
    status: 'ok',
    limits: [
      { label: '5h', kind: 'session', percent: session, resetsAt: at(3), severity: 'normal' },
      { label: 'Week (all)', kind: 'weekly', percent: weekly, resetsAt: at(weeklyIn), severity: 'normal' },
      { label: 'Week (Fable)', kind: 'model', percent: fable, resetsAt: at(weeklyIn), severity: 'critical' },
    ],
  });
  const chatgpt: AccountUsage = {
    account: { provider: 'chatgpt', label: 'pro' },
    status: 'ok',
    limits: [{ label: 'Week', kind: 'weekly', percent: 100, resetsAt: at(71), severity: 'critical' }],
  };

  it('names the account to use per provider and the model limits used up everywhere', () => {
    const output = renderRecommendation(
      [claudeAccount('soon', 10, 56, 17.65, 100), claudeAccount('later', 74, 69, 94, 100), chatgpt],
      now,
      { color: false },
    );
    expect(output.split('\n')).toEqual([
      'Recommendation',
      '  Claude   use claude/soon: 44 % of its weekly limit lapses in 17h 39m; 5h window 90 % free',
      '  ChatGPT  nothing usable now; chatgpt/pro frees up in 2d 23h (Sat 22:00)',
      '',
      'Model limits',
      '  Week (Fable) (Claude)  used up on every account; frees up first in 17h 39m (Thu 16:39) on claude/soon',
    ]);
  });

  it('lists where a model is still available', () => {
    const output = renderRecommendation([claudeAccount('a', 0, 0, 90, 100), claudeAccount('b', 0, 0, 20, 30)], now, {
      color: false,
    });
    expect(output).toContain('Week (Fable) (Claude)  still available on claude/b');
  });

  it('says "now" instead of "in now" for a reset that has already passed', () => {
    const past = at(-1);
    const output = renderRecommendation(
      [
        {
          account: { provider: 'chatgpt', label: 'pro' },
          status: 'ok',
          limits: [{ label: 'Week', kind: 'weekly', percent: 100, resetsAt: past, severity: 'critical' }],
        },
      ],
      now,
      { color: false },
    );
    expect(output).not.toContain('in now');
    expect(output).toContain(`chatgpt/pro frees up now (${formatReset(past)})`);
  });

  it('says when a provider reports no limit data', () => {
    const output = renderRecommendation([{ account: { provider: 'claude', label: 'x' }, status: 'ok', limits: [] }], now, {
      color: false,
    });
    expect(output).toContain('Claude  no 5h or weekly limit data to recommend from');
  });

  it('is empty without usable data', () => {
    expect(renderRecommendation([usages[1]!], now, { color: false })).toBe('');
  });
});
