import { describe, expect, it } from 'vitest';
import { recommend } from '../src/recommend.ts';
import type { AccountUsage, Limit, ProviderId } from '../src/types.ts';

const now = new Date('2026-11-18T22:00:00Z');
const inHours = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

const limit = (kind: Limit['kind'], label: string, percent: number | null, resetsInHours: number | null): Limit => ({
  label,
  kind,
  percent,
  severity: 'normal',
  resetsAt: resetsInHours === null ? null : inHours(resetsInHours),
});

const ok = (provider: ProviderId, label: string, limits: Limit[]): AccountUsage => ({
  account: { provider, label },
  status: 'ok',
  limits,
});

const claude = (label: string, session: number, weekly: number, weeklyResetsIn: number, fable = 100) =>
  ok('claude', label, [
    limit('session', '5h', session, 3),
    limit('weekly', 'Week (all)', weekly, weeklyResetsIn),
    limit('model', 'Week (Fable)', fable, weeklyResetsIn),
  ]);

describe('recommend', () => {
  it('picks the account whose weekly allowance lapses first', () => {
    const advice = recommend(
      [
        claude('soon', 10, 56, 17.65), // 44 % left, lapses in under a day
        claude('later', 74, 69, 94), // 31 % left over four days
        claude('mid', 30, 50, 60),
      ],
      now,
    );
    expect(advice.providers).toEqual([
      expect.objectContaining({ provider: 'claude', accountId: 'claude/soon', weeklyLeft: 44, sessionLeft: 90 }),
    ]);
  });

  it('uses the account whose allowance lapses first, even if another needs more % per hour', () => {
    // X: 5 % left for 2h (2.5 %/h). Y: 60 % left for 10h (6 %/h). Deadline order loses nothing.
    const advice = recommend([claude('y', 0, 40, 10), claude('x', 0, 95, 2)], now);
    expect(advice.providers[0]?.accountId).toBe('claude/x');
  });

  it('puts an unknown weekly reset after every known one', () => {
    const advice = recommend([ok('claude', 'unknown', [limit('weekly', 'Week (all)', 10, null)]), claude('known', 0, 10, 150)], now);
    expect(advice.providers[0]?.accountId).toBe('claude/known');
  });

  it('skips accounts whose 5h or weekly limit is used up', () => {
    const advice = recommend([claude('blocked-5h', 100, 10, 2), claude('blocked-week', 0, 100, 1), claude('free', 0, 0, 150)], now);
    expect(advice.providers[0]?.accountId).toBe('claude/free');
  });

  it('prefers an account with room in its 5h window over a slightly more urgent one that is nearly out', () => {
    const advice = recommend([claude('nearly-out', 97, 10, 20), claude('roomy', 20, 40, 60)], now);
    expect(advice.providers[0]?.accountId).toBe('claude/roomy');
  });

  it('falls back to a nearly-out account when it is the only usable one', () => {
    const advice = recommend([claude('nearly-out', 97, 10, 20), claude('blocked', 100, 0, 20)], now);
    expect(advice.providers[0]?.accountId).toBe('claude/nearly-out');
  });

  it('says when nothing is usable and which account frees up first', () => {
    const advice = recommend(
      [
        ok('chatgpt', 'a', [limit('weekly', 'Week', 100, 71)]),
        ok('chatgpt', 'b', [limit('weekly', 'Week', 100, 30)]),
      ],
      now,
    );
    expect(advice.providers).toEqual([
      { provider: 'chatgpt', accountId: null, availableAt: inHours(30), availableAccountId: 'chatgpt/b' },
    ]);
  });

  it('waits for the later of two exhausted limits on the same account', () => {
    const advice = recommend(
      [ok('claude', 'x', [limit('session', '5h', 100, 2), limit('weekly', 'Week (all)', 100, 40)])],
      now,
    );
    expect(advice.providers[0]).toMatchObject({ accountId: null, availableAt: inHours(40) });
  });

  it('gives advice per provider and ignores accounts that failed to load', () => {
    const advice = recommend(
      [
        claude('one', 0, 0, 100),
        { account: { provider: 'claude', label: 'broken' }, status: 'error', message: 'Login expired' },
        ok('chatgpt', 'pro', [limit('weekly', 'Week', 20, 50)]),
      ],
      now,
    );
    expect(advice.providers.map((entry) => [entry.provider, entry.accountId])).toEqual([
      ['claude', 'claude/one'],
      ['chatgpt', 'chatgpt/pro'],
    ]);
  });

  it('notes a model limit used up everywhere and where it frees up first', () => {
    const advice = recommend([claude('a', 0, 0, 90), claude('b', 0, 0, 20)], now);
    expect(advice.models).toEqual([
      { provider: 'claude', label: 'Week (Fable)', availableOn: [], availableAt: inHours(20), availableAccountId: 'claude/b' },
    ]);
  });

  it('notes where a model is still available when it is used up on some accounts', () => {
    const advice = recommend([claude('a', 0, 0, 90, 100), claude('b', 0, 0, 20, 30)], now);
    expect(advice.models).toEqual([
      { provider: 'claude', label: 'Week (Fable)', availableOn: ['claude/b'], availableAt: null },
    ]);
  });

  it('treats a blocked model without percent as used up and skips models available everywhere', () => {
    const blocked: Limit = { ...limit('model', 'gpt-6-astra', null, 71), detail: 'blocked' };
    const available: Limit = { ...limit('model', 'gpt-6', null, null), detail: 'available' };
    const advice = recommend([ok('chatgpt', 'pro', [limit('weekly', 'Week', 100, 71), blocked, available])], now);
    expect(advice.models).toEqual([
      { provider: 'chatgpt', label: 'gpt-6-astra', availableOn: [], availableAt: inHours(71), availableAccountId: 'chatgpt/pro' },
    ]);
  });

  it('ranks by the weekly allowance even when another account has only a 5h window', () => {
    const advice = recommend(
      [ok('claude', 'no-weekly', [limit('session', '5h', 10, 3)]), claude('weekly-urgent', 0, 20, 5)],
      now,
    );
    expect(advice.providers[0]?.accountId).toBe('claude/weekly-urgent');
  });

  it('never recommends an account without any 5h or weekly data', () => {
    const advice = recommend(
      [ok('claude', 'unknown-kinds', [limit(undefined, 'five_hour', 0, 3)]), ok('claude', 'empty', []), claude('real', 95, 50, 50)],
      now,
    );
    expect(advice.providers[0]?.accountId).toBe('claude/real');
  });

  it('reports missing limit data instead of recommending a blind account', () => {
    const advice = recommend([ok('claude', 'empty', [])], now);
    expect(advice.providers).toEqual([{ provider: 'claude', accountId: null, noData: true }]);
  });

  it('does not name a first account when another one frees up at an unknown time', () => {
    const advice = recommend(
      [ok('claude', 'known', [limit('weekly', 'Week (all)', 100, 30)]), ok('claude', 'unknown', [limit('weekly', 'Week (all)', 100, null)])],
      now,
    );
    expect(advice.providers).toEqual([{ provider: 'claude', accountId: null, availableAt: null }]);
  });

  it('does not name a first account for a model when one of its resets is unknown', () => {
    const blocked = (resetsIn: number | null): Limit => ({ ...limit('model', 'gpt-x', null, resetsIn), detail: 'blocked' });
    const advice = recommend(
      [ok('chatgpt', 'a', [limit('weekly', 'Week', 0, 50), blocked(10)]), ok('chatgpt', 'b', [limit('weekly', 'Week', 0, 50), blocked(null)])],
      now,
    );
    expect(advice.models).toEqual([{ provider: 'chatgpt', label: 'gpt-x', availableOn: [], availableAt: null }]);
  });

  it('puts an account with a used-up limit of unknown kind behind the others', () => {
    const advice = recommend(
      [
        ok('claude', 'odd', [
          limit('session', '5h', 0, 3),
          limit('weekly', 'Week (all)', 0, 5),
          limit(undefined, 'monthly_x', 100, 100),
        ]),
        claude('normal', 0, 50, 100),
      ],
      now,
    );
    expect(advice.providers[0]?.accountId).toBe('claude/normal');
  });

  it('returns nothing for no accounts', () => {
    expect(recommend([], now)).toEqual({ providers: [], models: [], plan: [] });
  });
});

describe('plan', () => {
  it('orders accounts by weekly reset and marks free model limits and blocked 5h windows', () => {
    const { plan } = recommend(
      [
        claude('late', 33, 74, 106, 60), // Fable 40 % left
        claude('first', 3, 57, 5), // Fable used up
        ok('claude', 'blocked', [limit('session', '5h', 100, 2), limit('weekly', 'Week (all)', 73, 33), limit('model', 'Week (Fable)', 100, 33)]),
      ],
      now,
    );
    expect(plan).toEqual([
      {
        provider: 'claude',
        steps: [
          { accountId: 'claude/first', weeklyLeft: 43, resetsAt: inHours(5), premium: [] },
          { accountId: 'claude/blocked', weeklyLeft: 27, resetsAt: inHours(33), premium: [], sessionBlocked: { label: '5h', resetsAt: inHours(2) } },
          { accountId: 'claude/late', weeklyLeft: 26, resetsAt: inHours(106), premium: ['Week (Fable)'] },
        ],
        back: [
          { label: 'Week (Fable)', accountId: 'claude/first', at: inHours(5) },
          { label: 'Week (Fable)', accountId: 'claude/blocked', at: inHours(33) },
        ],
      },
    ]);
  });

  it('puts an unknown weekly reset last and skips a weekly limit without percent', () => {
    const { plan } = recommend(
      [
        ok('claude', 'unknown', [limit('weekly', 'Week (all)', 10, null)]),
        ok('claude', 'no-percent', [limit('weekly', 'Week (all)', null, 5)]),
        claude('known', 0, 10, 150),
      ],
      now,
    );
    expect(plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/known', 'claude/unknown']);
  });

  it('lists every model limit with room', () => {
    const { plan } = recommend(
      [ok('claude', 'x', [limit('weekly', 'Week (all)', 0, 50), limit('model', 'Week (Fable)', 0, 50), limit('model', 'Week (Opus)', 10, 50)])],
      now,
    );
    expect(plan[0]?.steps[0]?.premium).toEqual(['Week (Fable)', 'Week (Opus)']);
  });

  it('keeps 5h-blocked accounts in the plan while the recommendation finds nothing usable', () => {
    const advice = recommend([ok('claude', 'x', [limit('session', '5h', 100, 2), limit('weekly', 'Week (all)', 50, 50)])], now);
    expect(advice.providers[0]?.accountId).toBeNull();
    expect(advice.plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/x']);
  });

  it('starts with the recommended account when it has room', () => {
    const advice = recommend([claude('a', 0, 40, 10), claude('b', 0, 95, 2), claude('c', 50, 0, 100)], now);
    expect(advice.plan[0]?.steps[0]?.accountId).toBe(advice.providers[0]?.accountId);
  });
});
