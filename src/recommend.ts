import { accountId, type AccountUsage, type Limit, type ProviderId } from './types.ts';

/**
 * Which account to work on now so that as little of each subscription as possible lapses unused.
 *
 * Unused weekly allowance is lost at the weekly reset, so accounts are worked through by deadline:
 * the one whose weekly limit resets first comes first (unknown resets last). Deadline order loses
 * nothing whenever everything can be used in time, unlike ranking by % per hour needed: with X at
 * 5 % left for 2h and Y at 60 % left for 10h, Y needs more per hour, but working on Y lets X's 5 %
 * lapse, while X first takes an hour and still leaves 9h for Y.
 * Accounts whose 5h or weekly limit is used up cannot be used and are skipped, and so are accounts
 * that report neither limit (nothing to judge them by). Accounts with less than SESSION_ROOM % of
 * their 5h window left come last, since they would stop again within minutes, and so do accounts
 * with a used-up limit of unknown kind. Accounts without a weekly limit come after those with one
 * and are ranked among themselves by their 5h window's % per hour, since they have no deadline.
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

/** One account in the plan: burn its weekly allowance before `resetsAt`. */
export interface PlanStep {
  accountId: string;
  /** Weekly % left, floored only when rendered. */
  weeklyLeft: number;
  /** Weekly reset: the deadline for this step. */
  resetsAt: Date | null;
  /** Models (see `modelName`) with room in every one of their limits on this account, e.g. ["Fable"]. */
  premium: string[];
  /** Set only when the 5h window is used up: its label and reset. */
  sessionBlocked?: { label: string; resetsAt: Date | null };
}

/** A model limit used up on one account, and when it comes back there. */
export interface ModelBack {
  label: string;
  accountId: string;
  at: Date | null;
}

/** Accounts of one provider in the order to burn them (earliest weekly reset first). */
export interface ProviderPlan {
  provider: ProviderId;
  steps: PlanStep[];
  /** Model limits used up on an account of this provider, sorted by `at`, unknown last. */
  back: ModelBack[];
}

export interface Advice {
  providers: ProviderAdvice[];
  models: ModelAdvice[];
  /** Same provider order as `providers`. */
  plan: ProviderPlan[];
}

export const SESSION_ROOM = 10;
export const HOUR_MS = 3_600_000;
// Weekly limit without a known reset: assume a full week, so it never looks more urgent than it is.
const UNKNOWN_RESET_HOURS = 7 * 24;

type OkUsage = Extract<AccountUsage, { status: 'ok' }>;

export const isUsedUp = (limit: Limit): boolean => (limit.percent ?? 0) >= 100 || limit.detail === 'blocked';
/** % of the limit still unused, or undefined when the limit or its percentage is missing. */
export const percentLeft = (limit: Limit | undefined): number | undefined =>
  limit?.percent === null || limit === undefined ? undefined : Math.max(0, 100 - limit.percent);
export const findKind = (usage: OkUsage, kind: Limit['kind']) => usage.limits.find((limit) => limit.kind === kind);

/** Under SESSION_ROOM % left of the 5h window: too little to start work on. Unknown usage is not low. */
export const isSessionLow = (session: Limit | undefined): boolean => (percentLeft(session) ?? 100) < SESSION_ROOM;

/** Used-up limits of unknown kind: they may or may not gate the account, so it counts like a nearly full 5h window. */
export const unknownUsedUp = (usage: OkUsage): Limit[] => usage.limits.filter((limit) => !limit.kind && isUsedUp(limit));

/** The latest reset of these limits, or null when there are none or any of them is unknown. */
export function latestReset(limits: Limit[]): Date | null {
  if (limits.some((limit) => limit.resetsAt === null)) return null;
  return limits.reduce<Date | null>((latest, limit) => (!latest || limit.resetsAt! > latest ? limit.resetsAt : latest), null);
}

/** Latest reset among the used-up gating limits, i.e. when the account is usable again (null if unknown). */
export const freesUpAt = (usage: OkUsage): Date | null =>
  latestReset(usage.limits.filter((limit) => (limit.kind === 'session' || limit.kind === 'weekly') && isUsedUp(limit)));

/** The entry with the earliest date, or undefined when any date is unknown (then nobody is known to be first). */
function earliest<T>(entries: T[], dateOf: (entry: T) => Date | null): T | undefined {
  if (entries.some((entry) => dateOf(entry) === null)) return undefined;
  return [...entries].sort((first, second) => dateOf(first)!.getTime() - dateOf(second)!.getTime())[0];
}

/** % per hour this limit would have to be used at to use up what is left before its reset. */
function urgency(gate: Limit | undefined, now: Date): number {
  const remaining = percentLeft(gate) ?? 0;
  const hours = gate?.resetsAt ? Math.max((gate.resetsAt.getTime() - now.getTime()) / HOUR_MS, 1 / 60) : UNKNOWN_RESET_HOURS;
  return remaining / hours;
}

/** Earlier reset first; an unknown reset sorts after every known one. */
export function byDeadline(first: Pick<Limit, 'resetsAt'>, second: Pick<Limit, 'resetsAt'>): number {
  const time = (limit: Pick<Limit, 'resetsAt'>) => limit.resetsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const difference = time(first) - time(second);
  return Number.isNaN(difference) ? 0 : difference;
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
  const hasRoom = (usage: OkUsage) => !isSessionLow(findKind(usage, 'session')) && unknownUsedUp(usage).length === 0;
  const hasWeekly = (usage: OkUsage) => findKind(usage, 'weekly') !== undefined;
  const rankSession = (usage: OkUsage) => urgency(findKind(usage, 'session'), now);
  const [best] = [...usable].sort(
    (first, second) =>
      Number(hasRoom(second)) - Number(hasRoom(first)) ||
      Number(hasWeekly(second)) - Number(hasWeekly(first)) ||
      (hasWeekly(first) ? byDeadline(findKind(first, 'weekly')!, findKind(second, 'weekly')!) : rankSession(second) - rankSession(first)),
  );
  const weekly = findKind(best!, 'weekly');
  const session = findKind(best!, 'session');
  const sessionLeft = percentLeft(session);
  const weeklyLeft = percentLeft(weekly);
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

/**
 * The model a model-specific limit belongs to: "Fable" from Claude's "Week (Fable)", "GPT-6 Pro" from
 * ChatGPT's "GPT-6 Pro 5h" / "GPT-6 Pro Week"; any other label (e.g. "gpt-6-astra") is the model itself.
 */
export function modelName(label: string): string {
  const scoped = label.match(/\(([^)]+)\)$/)?.[1];
  if (scoped) return scoped;
  return label.replace(/ (?:Week|\d+[mhd])$/, '');
}

function planProvider(provider: ProviderId, usages: OkUsage[]): ProviderPlan {
  const steps = usages
    .flatMap((usage): PlanStep[] => {
      const weekly = findKind(usage, 'weekly');
      if (!weekly || weekly.percent === null || isUsedUp(weekly)) return [];
      const session = findKind(usage, 'session');
      const modelLimits = usage.limits.filter((limit) => limit.kind === 'model');
      const blocked = new Set(modelLimits.filter(isUsedUp).map((limit) => modelName(limit.label)));
      const premium = [...new Set(modelLimits.map((limit) => modelName(limit.label)))].filter((model) => !blocked.has(model));
      return [
        {
          accountId: accountId(usage.account),
          weeklyLeft: percentLeft(weekly)!,
          resetsAt: weekly.resetsAt,
          premium,
          ...(session && isUsedUp(session) ? { sessionBlocked: { label: session.label, resetsAt: session.resetsAt } } : {}),
        },
      ];
    })
    .sort(byDeadline);
  const back = usages
    .flatMap((usage) =>
      usage.limits
        .filter((limit) => limit.kind === 'model' && isUsedUp(limit))
        .map((limit): ModelBack => ({ label: limit.label, accountId: accountId(usage.account), at: limit.resetsAt })),
    )
    .sort((first, second) => byDeadline({ resetsAt: first.at }, { resetsAt: second.at }));
  return { provider, steps, back };
}

export function recommend(usages: AccountUsage[], now: Date): Advice {
  const okUsages = usages.filter((usage): usage is OkUsage => usage.status === 'ok');
  const providers = [...new Set(okUsages.map((usage) => usage.account.provider))];
  const byProvider = (provider: ProviderId) => okUsages.filter((usage) => usage.account.provider === provider);
  const advice = providers.map((provider) => adviseProvider(provider, byProvider(provider), now));
  return {
    providers: advice,
    models: providers.flatMap((provider) => adviseModels(provider, byProvider(provider))),
    plan: providers.map((provider, index) => recommendedFirst(planProvider(provider, byProvider(provider)), advice[index]!.accountId)),
  };
}

/**
 * The recommended account goes first, so in the JSON output `plan` starts with the account `providers` names.
 * It differs from the earliest deadline only when that account has (almost) no room in its 5h window. The
 * text output keeps such an account in its deadline place instead and marks it as waiting (see render.ts).
 */
function recommendedFirst(plan: ProviderPlan, recommended: string | null): ProviderPlan {
  const index = plan.steps.findIndex((step) => step.accountId === recommended);
  if (index <= 0) return plan;
  return { ...plan, steps: [plan.steps[index]!, ...plan.steps.slice(0, index), ...plan.steps.slice(index + 1)] };
}
