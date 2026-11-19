import { accountId, type AccountUsage, type Limit, type ProviderId } from './types.ts';

/**
 * Which account to work on now so that as little of each subscription as possible lapses unused.
 *
 * Unused weekly allowance is lost at the weekly reset, so the most urgent account is the one that
 * would have to burn the most percent per hour to use up what is left: weekly % left / hours to reset.
 * Accounts whose 5h or weekly limit is used up cannot be used and are skipped, and so are accounts
 * that report neither limit (nothing to judge them by). Accounts with less than SESSION_ROOM % of
 * their 5h window left come last, since they would stop again within minutes, and so do accounts
 * with a used-up limit of unknown kind. Accounts without a
 * weekly limit come after those with one and are ranked among themselves by their 5h window, since
 * a 5h window's % per hour is not comparable with a weekly one.
 */

export interface ProviderAdvice {
  provider: ProviderId;
  /** Recommended account, or null when no account of this provider is usable now. */
  accountId: string | null;
  weeklyLeft?: number;
  weeklyResetsAt?: Date | null;
  sessionLeft?: number;
  /** Label of that short window, e.g. "5h" (Claude, ChatGPT) or "2h" (Grok free). */
  sessionLabel?: string;
  /** When nothing is usable: the earliest moment an account frees up, and which one. */
  availableAt?: Date | null;
  availableAccountId?: string;
  /** No account reports a 5h or weekly limit, so there is nothing to recommend from. */
  noData?: true;
}

/** A model-specific limit (e.g. Claude "Week (Fable)") that is used up on at least one account. */
export interface ModelAdvice {
  provider: ProviderId;
  label: string;
  availableOn: string[];
  /** When it is used up everywhere: the earliest reset, and on which account. */
  availableAt: Date | null;
  availableAccountId?: string;
}

export interface Advice {
  providers: ProviderAdvice[];
  models: ModelAdvice[];
}

const SESSION_ROOM = 10;
const HOUR_MS = 3_600_000;
// Weekly limit without a known reset: assume a full week, so it never looks more urgent than it is.
const UNKNOWN_RESET_HOURS = 7 * 24;

type OkUsage = Extract<AccountUsage, { status: 'ok' }>;

const isUsedUp = (limit: Limit): boolean => (limit.percent ?? 0) >= 100 || limit.detail === 'blocked';
const left = (limit: Limit | undefined): number | undefined =>
  limit?.percent === null || limit === undefined ? undefined : Math.max(0, 100 - limit.percent);
const findKind = (usage: OkUsage, kind: Limit['kind']) => usage.limits.find((limit) => limit.kind === kind);

/** Latest reset among the used-up gating limits, i.e. when the account is usable again (null if unknown). */
function freesUpAt(usage: OkUsage): Date | null {
  const blocking = usage.limits.filter((limit) => (limit.kind === 'session' || limit.kind === 'weekly') && isUsedUp(limit));
  if (blocking.some((limit) => limit.resetsAt === null)) return null;
  return blocking.reduce<Date | null>((latest, limit) => (!latest || limit.resetsAt! > latest ? limit.resetsAt : latest), null);
}

/** The entry with the earliest date, or undefined when any date is unknown (then nobody is known to be first). */
function earliest<T>(entries: T[], dateOf: (entry: T) => Date | null): T | undefined {
  if (entries.some((entry) => dateOf(entry) === null)) return undefined;
  return [...entries].sort((first, second) => dateOf(first)!.getTime() - dateOf(second)!.getTime())[0];
}

/** % per hour this limit would have to be used at to use up what is left before its reset. */
function urgency(gate: Limit | undefined, now: Date): number {
  const remaining = left(gate) ?? 0;
  const hours = gate?.resetsAt ? Math.max((gate.resetsAt.getTime() - now.getTime()) / HOUR_MS, 1 / 60) : UNKNOWN_RESET_HOURS;
  return remaining / hours;
}

const hasGate = (usage: OkUsage): boolean => findKind(usage, 'weekly') !== undefined || findKind(usage, 'session') !== undefined;

function adviseProvider(provider: ProviderId, allUsages: OkUsage[], now: Date): ProviderAdvice {
  const usages = allUsages.filter(hasGate);
  if (usages.length === 0) return { provider, accountId: null, noData: true };
  const usable = usages.filter((usage) => !usage.limits.some((limit) => limit.kind !== 'model' && limit.kind && isUsedUp(limit)));
  if (usable.length === 0) {
    const first = earliest(usages, freesUpAt);
    return {
      provider,
      accountId: null,
      availableAt: first ? freesUpAt(first) : null,
      ...(first ? { availableAccountId: accountId(first.account) } : {}),
    };
  }
  // A used-up limit of unknown kind may or may not gate the account, so it counts like a nearly full 5h window.
  const hasRoom = (usage: OkUsage) =>
    (left(findKind(usage, 'session')) ?? 100) >= SESSION_ROOM && !usage.limits.some((limit) => !limit.kind && isUsedUp(limit));
  const hasWeekly = (usage: OkUsage) => findKind(usage, 'weekly') !== undefined;
  const rankUrgency = (usage: OkUsage) => urgency(findKind(usage, 'weekly') ?? findKind(usage, 'session'), now);
  const [best] = [...usable].sort(
    (first, second) =>
      Number(hasRoom(second)) - Number(hasRoom(first)) ||
      Number(hasWeekly(second)) - Number(hasWeekly(first)) ||
      rankUrgency(second) - rankUrgency(first),
  );
  const weekly = findKind(best!, 'weekly');
  const session = findKind(best!, 'session');
  const sessionLeft = left(session);
  const weeklyLeft = left(weekly);
  return {
    provider,
    accountId: accountId(best!.account),
    ...(weeklyLeft !== undefined ? { weeklyLeft, weeklyResetsAt: weekly!.resetsAt } : {}),
    ...(sessionLeft !== undefined ? { sessionLeft, sessionLabel: session!.label } : {}),
  };
}

function adviseModels(provider: ProviderId, usages: OkUsage[]): ModelAdvice[] {
  const labels = [...new Set(usages.flatMap((usage) => usage.limits.filter((limit) => limit.kind === 'model').map((limit) => limit.label)))];
  return labels.flatMap((label): ModelAdvice[] => {
    const entries = usages.flatMap((usage) => {
      const limit = usage.limits.find((candidate) => candidate.kind === 'model' && candidate.label === label);
      return limit ? [{ id: accountId(usage.account), limit }] : [];
    });
    if (!entries.some((entry) => isUsedUp(entry.limit))) return [];
    const availableOn = entries.filter((entry) => !isUsedUp(entry.limit)).map((entry) => entry.id);
    if (availableOn.length > 0) return [{ provider, label, availableOn, availableAt: null }];
    const first = earliest(entries, (entry) => entry.limit.resetsAt);
    return [
      {
        provider,
        label,
        availableOn,
        availableAt: first?.limit.resetsAt ?? null,
        ...(first ? { availableAccountId: first.id } : {}),
      },
    ];
  });
}

export function recommend(usages: AccountUsage[], now: Date): Advice {
  const okUsages = usages.filter((usage): usage is OkUsage => usage.status === 'ok');
  const providers = [...new Set(okUsages.map((usage) => usage.account.provider))];
  const byProvider = (provider: ProviderId) => okUsages.filter((usage) => usage.account.provider === provider);
  return {
    providers: providers.map((provider) => adviseProvider(provider, byProvider(provider), now)),
    models: providers.flatMap((provider) => adviseModels(provider, byProvider(provider))),
  };
}
