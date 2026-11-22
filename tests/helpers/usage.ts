import { severityForPercent, type AccountUsage, type Limit, type LimitKind, type ProviderId } from '../../src/types.ts';

const HOUR_MS = 3_600_000;

type OkUsage = Extract<AccountUsage, { status: 'ok' }>;

/**
 * Builders for the normalised limits and account rows, with resets given in hours from `now`
 * (null = unknown). Shared by the tests and scripts/readme-examples.ts, so both describe an account
 * the same way.
 */
export function usageBuilders(now: Date) {
  const at = (hours: number): Date => new Date(now.getTime() + hours * HOUR_MS);

  /** Any limit; without a kind it is one the recommendation does not know. Severity follows the percentage. */
  const limit = (label: string, kind: LimitKind | undefined, percent: number | null, hours: number | null): Limit => ({
    label,
    ...(kind ? { kind } : {}),
    percent,
    resetsAt: hours === null ? null : at(hours),
    severity: percent === null ? 'normal' : severityForPercent(percent),
  });

  const session = (percent: number, hours: number | null): Limit => limit('5h', 'session', percent, hours);
  const week = (percent: number, hours: number | null, label = 'Week (all)'): Limit => limit(label, 'weekly', percent, hours);
  const fable = (percent: number, hours: number | null): Limit => limit('Week (Fable)', 'model', percent, hours);

  /** ChatGPT's per-model gate: a percentage, or no percentage and a 'blocked' / 'available' detail. */
  const astra = (state: number | 'blocked' | 'available', hours: number | null): Limit => {
    if (typeof state === 'number') return limit('gpt-6-astra', 'model', state, hours);
    return { ...limit('gpt-6-astra', 'model', null, hours), severity: state === 'blocked' ? 'critical' : 'normal', detail: state };
  };

  const ok = (provider: ProviderId, label: string, limits: Limit[]): OkUsage => ({ account: { provider, label }, status: 'ok', limits });
  const failed = (provider: ProviderId, label: string, message: string, hint?: string): AccountUsage => ({
    account: { provider, label },
    status: 'error',
    message,
    ...(hint ? { hint } : {}),
  });

  return { at, limit, session, week, fable, astra, ok, failed };
}
