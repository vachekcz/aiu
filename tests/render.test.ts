import { describe, expect, it } from 'vitest';
import { colorMode, formatCountdown, renderJson, renderOverview, renderTools, renderUpdateOutcome, TRUECOLOR_PALETTE } from '../src/render.ts';
import type { ToolStatus } from '../src/tools.ts';
import type { AccountUsage, Limit } from '../src/types.ts';
import { usageBuilders } from './helpers/usage.ts';

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


describe('colorMode', () => {
  it('requires a TTY and no NO_COLOR', () => {
    expect(colorMode({ isTTY: false }, { COLORTERM: 'truecolor' })).toBe('none');
    expect(colorMode({ isTTY: true }, { NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none');
    expect(colorMode({ isTTY: true }, {})).toBe('basic');
    expect(colorMode({ isTTY: true }, { NO_COLOR: '' })).toBe('basic');
  });

  it('uses 24-bit colour when the terminal announces it in COLORTERM', () => {
    expect(colorMode({ isTTY: true }, { COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorMode({ isTTY: true }, { COLORTERM: '24bit' })).toBe('truecolor');
    expect(colorMode({ isTTY: true }, { COLORTERM: 'yes' })).toBe('basic');
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
        providers: [{ provider: 'claude', accountId: 'claude/personal', sessionLeft: 20, sessionLabel: '5h' }],
        models: [
          {
            provider: 'claude',
            label: 'Week (Fable)',
            availableOn: [],
            availableAt: '2026-11-20T18:00:00.000Z',
            availableAccountId: 'claude/personal',
          },
        ],
        plan: [
          {
            provider: 'claude',
            steps: [],
            back: [{ label: 'Week (Fable)', accountId: 'claude/personal', at: '2026-11-20T18:00:00.000Z' }],
          },
        ],
      },
      tools: [],
    });
  });
});


describe('renderOverview', () => {
  const { at, session, week, fable, astra, ok } = usageBuilders(now);
  const claude = (label: string, limits: Limit[]) => ok('claude', label, limits);
  const chatgpt = (label: string, limits: Limit[]) => ok('chatgpt', label, limits);
  const plain = (usages: AccountUsage[]) => renderOverview(usages, now, { color: 'none' });
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const DIM = '\x1b[2m';

  it('names the account to use now, then lists accounts by weekly reset with shared columns', () => {
    const output = plain([
      claude('dotidot', [session(3, 4.5), week(9, 163), fable(0, 163)]),
      claude('info', [session(0, null), week(79, 96), fable(100, 96)]),
      claude('pvachek', [session(20, 4.5), week(78, 22.25), fable(100, 22.25)]),
      chatgpt('ja', [week(100, 24.5, 'Week'), astra('blocked', 24.5)]),
    ]);
    expect(output.split('\n')).toEqual([
      'Use now  which account to work on right now',
      '  ▶ Claude   use pvachek — 22 % lapses in 22h 15m · 5h 80 % free',
      '  ✗ ChatGPT  nothing usable — back in 1d 0h on ja',
      '',
      'Accounts  burn top to bottom: earliest weekly reset first',
      '    Claude   5h           Week              Fable        Resets in  Burn',
      '  ▶ pvachek  █░░░░  20 %  ████████░░  78 %  ✗ used       22h 15m     22 %',
      '    info     ░░░░░   0 %  ████████░░  79 %  ✗ used       4d 0h       21 %',
      '    dotidot  ░░░░░   3 %  █░░░░░░░░░   9 %    0 %        6d 19h      91 %  Fable first',
      '',
      '    ChatGPT  5h           Week              gpt-6-astra  Resets in  Burn',
      '  ✗ ja       —            ██████████ 100 %  ✗ used       1d 0h      —      week used up · back in 1d 0h',
    ]);
  });

  it('keeps an account waiting for its 5h window in place and recommends the next one', () => {
    const output = plain([
      claude('soon', [session(100, 2.5), week(78, 22), fable(100, 22)]),
      claude('later', [session(0, null), week(79, 96), fable(100, 96)]),
    ]);
    const lines = output.split('\n');
    expect(lines[1]).toBe('  ▶ Claude  use later — 21 % lapses in 4d 0h · 5h 100 % free · back to soon in 2h 30m');
    expect(lines[5]).toMatch(/^ {2}‖ soon +█████ 100 %/);
    expect(lines[5]).toContain('5h back in 2h 30m');
    expect(lines[6]).toMatch(/^ {2}▶ later/);
  });

  it('marks an account with under 10 % of its 5h window left as waiting', () => {
    const output = plain([claude('low', [session(93, 1), week(50, 20)]), claude('roomy', [session(10, 1), week(50, 40)])]);
    expect(output).toContain('‖ low');
    expect(output).toContain('5h 7 % left');
    expect(output).toContain('use roomy');
    expect(output).toContain('back to low in 1h 0m');
  });

  it('puts accounts with a used-up weekly limit after the burn order, red at 100 % and dimmed otherwise', () => {
    const usages = [
      claude('out', [session(0, null), week(100, 30), fable(100, 30)]),
      claude('a', [session(10, 2), week(60, 50)]),
      claude('b', [session(10, 2), week(20, 100)]),
    ];
    const lines = plain(usages).split('\n');
    expect(lines.slice(5, 8).map((line) => line.slice(4, 7))).toEqual(['a  ', 'b  ', 'out']);
    expect(lines[7]).toMatch(/^ {2}✗ out/);
    expect(lines[7]).toContain('week used up · back in 1d 6h');
    const colored = renderOverview(usages, now, { color: 'basic' });
    expect(colored).toContain(`${RED}██████████ 100 %`);
    expect(colored).toContain(`${DIM}░░░░░   0 %`);
  });

  it('colours how much is left by the pace needed to use it up and names that pace when it is tight', () => {
    const usages = [claude('rush', [session(0, null), week(35, 9)]), claude('tight', [session(0, null), week(30, 40)]), claude('easy', [session(0, null), week(9, 163)])];
    const output = plain(usages);
    expect(output).toContain('needs 7.2 %/h');
    expect(output).toContain('needs 1.8 %/h');
    expect(output).not.toMatch(/easy.*needs/);
    const colored = renderOverview(usages, now, { color: 'basic' });
    expect(colored).toContain(`${RED} 65 %`);
    expect(colored).toContain(`${YELLOW} 70 %`);
  });

  it('suggests each model with room once, on the first account in burn order that has it', () => {
    const output = plain([claude('first', [week(10, 10), fable(0, 10)]), claude('second', [week(10, 50), fable(0, 50)])]);
    expect(output).toMatch(/first .*Fable first/);
    expect(output).not.toMatch(/second .*Fable first/);
  });

  it('shows when a used-up model comes back when that differs from the weekly reset', () => {
    const pro5h: Limit = { label: 'GPT-6 Pro 5h', kind: 'model', percent: 100, resetsAt: at(2), severity: 'critical' };
    const pro: Limit = { label: 'GPT-6 Pro Week', kind: 'model', percent: 40, resetsAt: at(120), severity: 'normal' };
    const output = plain([chatgpt('pro', [week(40, 120, 'Week'), pro5h, pro, astra('blocked', 5)]), claude('max', [week(10, 50), fable(100, 50)])]);
    expect(output).toMatch(/▶ pro .*✗ 2h 0m +✗ 5h 0m +5d 0h/);
    expect(output).toMatch(/max .*✗ used/);
    const unknown = plain([chatgpt('x', [week(40, 120, 'Week'), { ...astra('blocked', 0), resetsAt: null }])]);
    expect(unknown).toMatch(/x .*✗ unknown/);
  });

  it('orders by the weekly reset even when the weekly limit has no percent', () => {
    const noPercent: Limit = { ...week(0, 5), percent: null, detail: 'n/a' };
    const lines = plain([claude('known', [week(10, 50)]), claude('no-percent', [noPercent])]).split('\n');
    expect(lines[1]).toContain('use no-percent');
    expect(lines[5]).toMatch(/^ {2}▶ no-percent/);
    expect(lines[6]).toMatch(/known/);
  });

  it('puts an unknown weekly reset last and says so', () => {
    const output = plain([claude('unknown', [week(30, null)]), claude('known', [week(30, 100)]), claude('also-unknown', [week(30, null)])]);
    const lines = output.split('\n');
    expect(lines[5]).toMatch(/known/);
    expect(lines[6]).toMatch(/unknown .*unknown .*reset unknown/);
    expect(lines[7]).toMatch(/also-unknown/);
  });

  it('lists accounts without limits and failed accounts last, and a provider whose accounts all failed', () => {
    const output = plain([
      claude('ok', [week(10, 10)]),
      { account: { provider: 'claude', label: 'broken' }, status: 'error', message: 'login expired', hint: 'aiu login claude --name broken' },
      claude('empty', []),
      ...usages.slice(1),
    ]);
    const lines = output.split('\n');
    expect(lines).toContain('  ✗ Grok    no data: every account failed');
    expect(lines.findIndex((line) => line.includes('empty'))).toBeGreaterThan(lines.findIndex((line) => line.includes('▶ ok')));
    expect(output).toContain('! broken  login expired — run: aiu login claude --name broken');
    expect(output).toMatch(/ {2}empty {3}no limits reported/);
    expect(output).toContain('    Grok\n  ! main    cookie expired — run: aiu login grok --name main');
  });

  it('shows the detail of a limit without percent', () => {
    const grok: AccountUsage = {
      account: { provider: 'grok', label: 'free' },
      status: 'ok',
      limits: [{ label: '2h', kind: 'session', percent: null, resetsAt: null, severity: 'normal', detail: '15/20 left' }],
    };
    const output = plain([grok, chatgpt('pro', [week(10, 30, 'Week'), astra('available', null)])]);
    expect(output).toContain('15/20 left');
    expect(output).toContain('available');
    expect(output).toMatch(/Grok +2h/);
  });

  it('says "now" for a weekly reset that has already passed', () => {
    const output = plain([claude('x', [week(40, -1)])]);
    expect(output).toContain('60 % lapses now');
    expect(output).not.toContain('in now');
  });

  it('says when a provider reports no 5h or weekly limit', () => {
    const output = plain([claude('x', [fable(10, 10)])]);
    expect(output).toContain('✗ Claude  no 5h or weekly limit data to recommend from');
  });

  it('emits ANSI codes only when color is enabled', () => {
    expect(plain(usages)).not.toContain('\x1b[');
    expect(renderOverview(usages, now, { color: 'basic' })).toContain('\x1b[1mUse now\x1b[0m');
  });

  it('prints the palette shades in 24-bit colour', () => {
    const output = renderOverview([claude('x', [week(100, 10)]), claude('y', [week(10, 20)])], now, { color: 'truecolor' });
    expect(TRUECOLOR_PALETTE.yellow).toBe('#f2a03d');
    expect(output).toContain('\x1b[38;2;242;97;97m██████████ 100 %');
    expect(output).toContain('\x1b[38;2;95;207;138m█░░░░░░░░░  10 %');
    expect(output).toContain('\x1b[1m\x1b[38;2;95;207;138m▶');
    expect(output).not.toMatch(/\x1b\[3[1-7]m/);
  });
});

describe('renderTools', () => {
  const tools: ToolStatus[] = [
    { id: 'claude', installed: '2.1.330', latest: '2.1.341', updateAvailable: true },
    { id: 'codex', installed: '0.171.0', latest: null, updateAvailable: false },
    { id: 'grok', installed: '1.0.89', latest: '1.0.89', updateAvailable: false },
  ];
  const current = tools.map((tool) => ({ ...tool, latest: tool.installed, updateAvailable: false }));

  it('lists each tool with its installed version and what is newer', () => {
    expect(renderTools(tools, { color: 'none' }).split('\n')).toEqual([
      'Tools  installed CLI versions · update with: aiu update',
      '    claude   2.1.330  → 2.1.341',
      '    codex    0.171.0',
      '    grok     1.0.89   ✓ latest',
    ]);
  });

  it('drops the update hint when nothing is outdated', () => {
    expect(renderTools(current, { color: 'none' }).split('\n')[0]).toBe('Tools  installed CLI versions');
  });

  it('is empty without tools', () => {
    expect(renderTools([], { color: 'none' })).toBe('');
  });

  it('colours the newer version yellow, the up-to-date mark green and the command cyan', () => {
    const colored = renderTools(tools, { color: 'basic' });
    expect(colored).toContain('\x1b[1mTools\x1b[0m');
    expect(colored).toContain('\x1b[33m→ 2.1.341\x1b[0m');
    expect(colored).toContain('\x1b[32m✓ latest\x1b[0m');
    expect(colored).toContain('\x1b[36maiu update\x1b[0m');
  });

  it('follows the accounts in the overview, after a blank line', () => {
    const output = renderOverview(usages, now, { color: 'none', tools });
    expect(output.split('\n').slice(-5)).toEqual(['', ...renderTools(tools, { color: 'none' }).split('\n')]);
    expect(renderOverview(usages, now, { color: 'none', tools: [] })).toBe(renderOverview(usages, now, { color: 'none' }));
  });

  it('is part of the JSON output', () => {
    expect(JSON.parse(renderJson(usages, now, tools)).tools).toEqual(tools);
    expect(JSON.parse(renderJson(usages, now)).tools).toEqual([]);
  });
});

describe('renderUpdateOutcome', () => {
  it('colours a failure red and a success green', () => {
    expect(renderUpdateOutcome({ id: 'grok', status: 'failed', version: '1.0.89', reason: 'boom' }, { color: 'basic' })).toContain('\x1b[31m! failed: boom\x1b[0m');
    expect(renderUpdateOutcome({ id: 'grok', status: 'updated', from: '1.0.89', to: '1.0.92' }, { color: 'basic' })).toContain('\x1b[32m✓ updated\x1b[0m');
  });
});
