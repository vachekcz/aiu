import { describe, expect, it } from 'vitest';
import { usageBuilders } from './usage.ts';

const now = new Date('2026-11-18T22:00:00Z');
const { at, limit, session, week, fable, astra, ok, failed } = usageBuilders(now);

describe('usageBuilders', () => {
  it('places resets in hours from now and keeps an unknown reset unknown', () => {
    expect(at(1.5)).toEqual(new Date('2026-11-18T23:30:00Z'));
    expect(session(10, 2).resetsAt).toEqual(new Date('2026-11-19T00:00:00Z'));
    expect(session(10, null).resetsAt).toBeNull();
  });

  it('derives the severity from the percentage', () => {
    expect(week(49, 1).severity).toBe('normal');
    expect(week(50, 1).severity).toBe('warning');
    expect(week(80, 1).severity).toBe('critical');
    expect(limit('Week', 'weekly', null, 1).severity).toBe('normal');
  });

  it('builds the limits the providers report', () => {
    expect(session(10, null)).toEqual({ label: '5h', kind: 'session', percent: 10, resetsAt: null, severity: 'normal' });
    expect(week(10, null)).toMatchObject({ label: 'Week (all)', kind: 'weekly' });
    expect(week(10, null, 'Week')).toMatchObject({ label: 'Week', kind: 'weekly' });
    expect(fable(10, null)).toMatchObject({ label: 'Week (Fable)', kind: 'model' });
  });

  it('leaves the kind out of a limit of unknown kind', () => {
    expect(limit('monthly_x', undefined, 100, null)).not.toHaveProperty('kind');
  });

  it('builds the three states of a ChatGPT model gate', () => {
    expect(astra('blocked', 5)).toEqual({ label: 'gpt-6-astra', kind: 'model', percent: null, resetsAt: at(5), severity: 'critical', detail: 'blocked' });
    expect(astra('available', null)).toEqual({ label: 'gpt-6-astra', kind: 'model', percent: null, resetsAt: null, severity: 'normal', detail: 'available' });
    expect(astra(40, 5)).toEqual({ label: 'gpt-6-astra', kind: 'model', percent: 40, resetsAt: at(5), severity: 'normal' });
  });

  it('builds ok and error rows', () => {
    expect(ok('claude', 'work', [])).toEqual({ account: { provider: 'claude', label: 'work' }, status: 'ok', limits: [] });
    expect(failed('grok', 'main', 'Login expired', 'aiu login grok --name main')).toEqual({
      account: { provider: 'grok', label: 'main' },
      status: 'error',
      message: 'Login expired',
      hint: 'aiu login grok --name main',
    });
    expect(failed('grok', 'main', 'Timed out')).not.toHaveProperty('hint');
  });
});
