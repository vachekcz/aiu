import { describe, expect, it } from 'vitest';
import { freesUpAt, isSessionLow, isUsedUp, latestReset, percentLeft, recommend, SESSION_ROOM, unknownUsedUp } from '../src/recommend.ts';
import type { Limit } from '../src/types.ts';
import { usageBuilders } from './helpers/usage.ts';

const now = new Date('2026-11-18T22:00:00Z');
const { at: inHours, limit, ok } = usageBuilders(now);

const claude = (label: string, session: number, weekly: number, weeklyResetsIn: number, fable = 100) =>
  ok('claude', label, [
    limit('5h', 'session', session, 3),
    limit('Week (all)', 'weekly', weekly, weeklyResetsIn),
    limit('Week (Fable)', 'model', fable, weeklyResetsIn),
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
    const advice = recommend([ok('claude', 'unknown', [limit('Week (all)', 'weekly', 10, null)]), claude('known', 0, 10, 150)], now);
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
        ok('chatgpt', 'a', [limit('Week', 'weekly', 100, 71)]),
        ok('chatgpt', 'b', [limit('Week', 'weekly', 100, 30)]),
      ],
      now,
    );
    expect(advice.providers).toEqual([
      { provider: 'chatgpt', accountId: null, availableAt: inHours(30), availableAccountId: 'chatgpt/b' },
    ]);
  });

  it('waits for the later of two exhausted limits on the same account', () => {
    const advice = recommend(
      [ok('claude', 'x', [limit('5h', 'session', 100, 2), limit('Week (all)', 'weekly', 100, 40)])],
      now,
    );
    expect(advice.providers[0]).toMatchObject({ accountId: null, availableAt: inHours(40) });
  });

  it('gives advice per provider and ignores accounts that failed to load', () => {
    const advice = recommend(
      [
        claude('one', 0, 0, 100),
        { account: { provider: 'claude', label: 'broken' }, status: 'error', message: 'Login expired' },
        ok('chatgpt', 'pro', [limit('Week', 'weekly', 20, 50)]),
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
    const blocked: Limit = { ...limit('gpt-6-astra', 'model', null, 71), detail: 'blocked' };
    const available: Limit = { ...limit('gpt-6', 'model', null, null), detail: 'available' };
    const advice = recommend([ok('chatgpt', 'pro', [limit('Week', 'weekly', 100, 71), blocked, available])], now);
    expect(advice.models).toEqual([
      { provider: 'chatgpt', label: 'gpt-6-astra', availableOn: [], availableAt: inHours(71), availableAccountId: 'chatgpt/pro' },
    ]);
  });

  it('ranks by the weekly allowance even when another account has only a 5h window', () => {
    const advice = recommend(
      [ok('claude', 'no-weekly', [limit('5h', 'session', 10, 3)]), claude('weekly-urgent', 0, 20, 5)],
      now,
    );
    expect(advice.providers[0]?.accountId).toBe('claude/weekly-urgent');
  });

  it('never recommends an account without any 5h or weekly data', () => {
    const advice = recommend(
      [ok('claude', 'unknown-kinds', [limit('five_hour', undefined, 0, 3)]), ok('claude', 'empty', []), claude('real', 95, 50, 50)],
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
      [ok('claude', 'known', [limit('Week (all)', 'weekly', 100, 30)]), ok('claude', 'unknown', [limit('Week (all)', 'weekly', 100, null)])],
      now,
    );
    expect(advice.providers).toEqual([{ provider: 'claude', accountId: null, availableAt: null }]);
  });

  it('does not name a first account for a model when one of its resets is unknown', () => {
    const blocked = (resetsIn: number | null): Limit => ({ ...limit('gpt-x', 'model', null, resetsIn), detail: 'blocked' });
    const advice = recommend(
      [ok('chatgpt', 'a', [limit('Week', 'weekly', 0, 50), blocked(10)]), ok('chatgpt', 'b', [limit('Week', 'weekly', 0, 50), blocked(null)])],
      now,
    );
    expect(advice.models).toEqual([{ provider: 'chatgpt', label: 'gpt-x', availableOn: [], availableAt: null }]);
  });

  it('puts an account with a used-up limit of unknown kind behind the others', () => {
    const advice = recommend(
      [
        ok('claude', 'odd', [
          limit('5h', 'session', 0, 3),
          limit('Week (all)', 'weekly', 0, 5),
          limit('monthly_x', undefined, 100, 100),
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
        ok('claude', 'blocked', [limit('5h', 'session', 100, 2), limit('Week (all)', 'weekly', 73, 33), limit('Week (Fable)', 'model', 100, 33)]),
      ],
      now,
    );
    expect(plan).toEqual([
      {
        provider: 'claude',
        steps: [
          { accountId: 'claude/first', weeklyLeft: 43, resetsAt: inHours(5), premium: [] },
          { accountId: 'claude/blocked', weeklyLeft: 27, resetsAt: inHours(33), premium: [], sessionBlocked: { label: '5h', resetsAt: inHours(2) } },
          { accountId: 'claude/late', weeklyLeft: 26, resetsAt: inHours(106), premium: ['Fable'] },
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
        ok('claude', 'unknown', [limit('Week (all)', 'weekly', 10, null)]),
        ok('claude', 'no-percent', [limit('Week (all)', 'weekly', null, 5)]),
        claude('known', 0, 10, 150),
      ],
      now,
    );
    expect(plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/known', 'claude/unknown']);
  });

  it('lists every model limit with room', () => {
    const { plan } = recommend(
      [ok('claude', 'x', [limit('Week (all)', 'weekly', 0, 50), limit('Week (Fable)', 'model', 0, 50), limit('Week (Opus)', 'model', 10, 50)])],
      now,
    );
    expect(plan[0]?.steps[0]?.premium).toEqual(['Fable', 'Opus']);
  });

  it('names a model once and only when none of its windows is used up', () => {
    const pro = (fiveHour: number, week: number) =>
      ok('chatgpt', 'pro', [limit('Week', 'weekly', 40, 50), limit('GPT-6 Pro 5h', 'model', fiveHour, 2), limit('GPT-6 Pro Week', 'model', week, 50)]);
    expect(recommend([pro(100, 30)], now).plan[0]?.steps[0]?.premium).toEqual([]);
    expect(recommend([pro(10, 30)], now).plan[0]?.steps[0]?.premium).toEqual(['GPT-6 Pro']);
  });

  it('keeps 5h-blocked accounts in the plan while the recommendation finds nothing usable', () => {
    const advice = recommend([ok('claude', 'x', [limit('5h', 'session', 100, 2), limit('Week (all)', 'weekly', 50, 50)])], now);
    expect(advice.providers[0]?.accountId).toBeNull();
    expect(advice.plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/x']);
  });

  it('moves the recommended account first when the earliest deadline has no room in its 5h window', () => {
    const advice = recommend([claude('low-room', 95, 50, 10), claude('roomy', 0, 20, 40)], now);
    expect(advice.providers[0]?.accountId).toBe('claude/roomy');
    expect(advice.plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/roomy', 'claude/low-room']);
  });

  it('starts with the recommended account when it has room', () => {
    const advice = recommend([claude('a', 0, 40, 10), claude('b', 0, 95, 2), claude('c', 50, 0, 100)], now);
    expect(advice.plan[0]?.steps[0]?.accountId).toBe(advice.providers[0]?.accountId);
  });
});

describe('shared limit rules', () => {
  const unknown = (label: string, percent: number, hours: number | null) => limit(label, undefined, percent, hours);

  it('percentLeft is what remains of a known limit, never negative', () => {
    expect(percentLeft(limit('Week', 'weekly', 30, 5))).toBe(70);
    expect(percentLeft(limit('Week', 'weekly', 120, 5))).toBe(0);
    expect(percentLeft(limit('Week', 'weekly', null, 5))).toBeUndefined();
    expect(percentLeft(undefined)).toBeUndefined();
  });

  it('isUsedUp covers a full limit and a blocked one without a percentage', () => {
    expect(isUsedUp(limit('5h', 'session', 99.9, 1))).toBe(false);
    expect(isUsedUp(limit('5h', 'session', 100, 1))).toBe(true);
    expect(isUsedUp({ ...limit('astra', 'model', null, 1), detail: 'blocked' })).toBe(true);
    expect(isUsedUp({ ...limit('astra', 'model', null, 1), detail: 'available' })).toBe(false);
  });

  it('isSessionLow starts right under SESSION_ROOM % left', () => {
    expect(isSessionLow(limit('5h', 'session', 100 - SESSION_ROOM, 1))).toBe(false);
    expect(isSessionLow(limit('5h', 'session', 100 - SESSION_ROOM + 0.1, 1))).toBe(true);
    expect(isSessionLow(limit('5h', 'session', 100, 1))).toBe(true);
  });

  it('isSessionLow treats a missing 5h window or percentage as room to work', () => {
    expect(isSessionLow(undefined)).toBe(false);
    expect(isSessionLow(limit('5h', 'session', null, 1))).toBe(false);
  });

  it('unknownUsedUp lists only used-up limits without a kind', () => {
    const usage = ok('grok', 'main', [limit('5h', 'session', 100, 1), unknown('Queries', 100, 2), unknown('Images', 40, 2)]);
    expect(unknownUsedUp(usage).map((entry) => entry.label)).toEqual(['Queries']);
  });

  it('latestReset is the last of the resets, or null when one is unknown or there are none', () => {
    expect(latestReset([limit('5h', 'session', 100, 2), limit('Week', 'weekly', 100, 30)])).toEqual(inHours(30));
    expect(latestReset([limit('5h', 'session', 100, 2), limit('Week', 'weekly', 100, null)])).toBeNull();
    expect(latestReset([])).toBeNull();
  });

  it('freesUpAt waits for every used-up gating limit and ignores models and limits with room', () => {
    const usage = ok('claude', 'work', [
      limit('5h', 'session', 100, 2),
      limit('Week (all)', 'weekly', 100, 30),
      limit('Week (Fable)', 'model', 100, 90),
    ]);
    const roomy = ok('claude', 'free', [limit('5h', 'session', 20, 2), limit('Week (all)', 'weekly', 20, 30)]);
    expect(freesUpAt(usage)).toEqual(inHours(30));
    expect(freesUpAt(roomy)).toBeNull();
  });
});
