import { recommend, type Advice } from './recommend.ts';
import { accountId, type AccountUsage, type Limit, type ProviderId, type Severity } from './types.ts';

const BAR_CELLS = 10;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
} as const;

const SEVERITY_COLOR: Record<Severity, string> = {
  normal: ANSI.green,
  warning: ANSI.yellow,
  critical: ANSI.red,
};

export function severityForPercent(percent: number): Severity {
  if (percent >= 80) return 'critical';
  if (percent >= 50) return 'warning';
  return 'normal';
}

/** Local weekday and time of the reset, e.g. "Fri 19:00". */
export function formatReset(resetsAt: Date | null): string {
  if (!resetsAt) return '';
  const weekday = resetsAt.toLocaleDateString('en-US', { weekday: 'short' });
  const time = resetsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${weekday} ${time}`;
}

/** Time left until the reset, e.g. "2d 3h", "3h 9m", "19m". */
export function formatCountdown(resetsAt: Date | null, now: Date): string {
  if (!resetsAt) return '';
  const remainingMs = resetsAt.getTime() - now.getTime();
  if (remainingMs <= 0) return 'now';
  // Round up, so a reset 20 s away reads "1m", not "0m".
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (DAY_MS / 60_000));
  const hours = Math.floor((totalMinutes % (DAY_MS / 60_000)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function shouldUseColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  // no-color.org: only a non-empty NO_COLOR disables colour.
  return Boolean(stream.isTTY) && !env.NO_COLOR;
}

interface Row {
  account: string;
  limit: string;
  used: string;
  resetsIn: string;
  resets: string;
  color?: string;
}

function formatUsed(limit: Limit): string {
  if (limit.percent === null) return limit.detail ?? 'n/a';
  const clamped = Math.min(100, Math.max(0, limit.percent));
  const filled = Math.round(clamped / (100 / BAR_CELLS));
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
  // Floor, so 79.6 % does not read as the 80 % threshold while it is still below it.
  const percentText = `${String(Math.floor(limit.percent)).padStart(3)} %`;
  const marker = limit.severity === 'critical' ? '  !' : '';
  return `${bar} ${percentText}${marker}`;
}

function rowsFor(usage: AccountUsage, now: Date): Row[] {
  const id = accountId(usage.account);
  if (usage.status === 'error') {
    const hint = usage.hint ? ` — run: ${usage.hint}` : '';
    return [{ account: id, limit: 'unavailable', used: `${usage.message}${hint}`, resetsIn: '', resets: '', color: ANSI.dim }];
  }
  if (usage.limits.length === 0) {
    return [{ account: id, limit: '', used: 'no limits reported', resetsIn: '', resets: '', color: ANSI.dim }];
  }
  return usage.limits.map((limit, index) => ({
    account: index === 0 ? id : '',
    limit: limit.label,
    used: formatUsed(limit),
    resetsIn: formatCountdown(limit.resetsAt, now),
    resets: formatReset(limit.resetsAt),
    color: SEVERITY_COLOR[limit.severity],
  }));
}

export function renderTable(usages: AccountUsage[], now: Date, options: { color: boolean }): string {
  const header: Row = { account: 'Account', limit: 'Limit', used: 'Used', resetsIn: 'Resets in', resets: 'Resets at' };
  const groups = usages.map((usage) => rowsFor(usage, now));
  const all = [header, ...groups.flat()];
  const width = (key: keyof Omit<Row, 'color'>) => Math.max(...all.map((row) => row[key].length));
  const widths = { account: width('account'), limit: width('limit'), used: width('used'), resetsIn: width('resetsIn') };

  const paint = (text: string, color: string | undefined) =>
    options.color && color ? `${color}${text}${ANSI.reset}` : text;

  const line = (row: Row, isHeader: boolean) => {
    const used = row.used.padEnd(widths.used);
    const text = [
      row.account.padEnd(widths.account),
      row.limit.padEnd(widths.limit),
      isHeader ? used : paint(used, row.color),
      row.resetsIn.padEnd(widths.resetsIn),
      row.resets,
    ].join('  ');
    return text.trimEnd();
  };

  // A blank line between accounts keeps each account's limits together.
  const body = groups.map((rows) => rows.map((row) => line(row, false)).join('\n')).join('\n\n');
  return [paint(line(header, true), ANSI.bold), body].filter(Boolean).join('\n');
}

const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' };

function whenFree(at: Date | null, now: Date): string {
  return at ? `in ${formatCountdown(at, now)} (${formatReset(at)})` : 'at an unknown time';
}

function providerLine(entry: Advice['providers'][number], now: Date): string {
  if (entry.accountId === null) {
    const who = entry.availableAccountId ? `${entry.availableAccountId} frees up ` : 'an account frees up ';
    return `nothing usable now; ${who}${whenFree(entry.availableAt ?? null, now)}`;
  }
  const details = [
    entry.weeklyLeft !== undefined
      ? `${Math.floor(entry.weeklyLeft)} % of its weekly limit lapses ${entry.weeklyResetsAt ? `in ${formatCountdown(entry.weeklyResetsAt, now)}` : 'at an unknown time'}`
      : null,
    entry.sessionLeft !== undefined ? `5h window ${Math.floor(entry.sessionLeft)} % free` : null,
  ].filter((detail) => detail !== null);
  return details.length > 0 ? `use ${entry.accountId}: ${details.join('; ')}` : `use ${entry.accountId}`;
}

function modelLine(entry: Advice['models'][number], now: Date): string {
  if (entry.availableOn.length > 0) return `still available on ${entry.availableOn.join(', ')}`;
  const where = entry.availableAccountId ? ` on ${entry.availableAccountId}` : '';
  return `used up on every account; frees up first ${whenFree(entry.availableAt, now)}${where}`;
}

/**
 * Which account to use now (see recommend.ts) and model limits that are used up somewhere.
 * Empty when there is nothing to advise.
 */
export function renderRecommendation(usages: AccountUsage[], now: Date, options: { color: boolean }): string {
  const advice = recommend(usages, now);
  if (advice.providers.length === 0) return '';
  const heading = (text: string) => (options.color ? `${ANSI.bold}${text}${ANSI.reset}` : text);
  const align = (entries: [string, string][]) => {
    const labelWidth = Math.max(...entries.map(([label]) => label.length));
    return entries.map(([label, text]) => `  ${label.padEnd(labelWidth)}  ${text}`);
  };
  const lines = [
    heading('Recommendation'),
    ...align(advice.providers.map((entry) => [PROVIDER_NAMES[entry.provider], providerLine(entry, now)])),
  ];
  if (advice.models.length > 0) {
    lines.push(
      '',
      heading('Model limits'),
      ...align(advice.models.map((entry) => [`${entry.label} (${PROVIDER_NAMES[entry.provider]})`, modelLine(entry, now)])),
    );
  }
  return lines.join('\n');
}

export function renderJson(usages: AccountUsage[], now: Date): string {
  const accounts = usages.map((usage) => {
    const base = {
      id: accountId(usage.account),
      provider: usage.account.provider,
      label: usage.account.label,
      status: usage.status,
    };
    if (usage.status === 'error') {
      return { ...base, message: usage.message, ...(usage.hint ? { hint: usage.hint } : {}) };
    }
    return {
      ...base,
      ...(usage.plan ? { plan: usage.plan } : {}),
      limits: usage.limits.map((limit) => ({
        label: limit.label,
        ...(limit.kind ? { kind: limit.kind } : {}),
        percent: limit.percent,
        resetsAt: limit.resetsAt ? limit.resetsAt.toISOString() : null,
        severity: limit.severity,
        ...(limit.detail ? { detail: limit.detail } : {}),
      })),
    };
  });
  // JSON.stringify turns the Dates in the advice into ISO strings.
  return JSON.stringify({ generatedAt: now.toISOString(), accounts, recommendation: recommend(usages, now) }, null, 2);
}
