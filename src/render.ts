import { accountId, type AccountUsage, type Limit, type Severity } from './types.ts';

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

export function formatReset(resetsAt: Date | null, now: Date): string {
  if (!resetsAt) return '';
  const remainingMs = resetsAt.getTime() - now.getTime();
  if (remainingMs <= 0) return 'now';
  if (remainingMs < DAY_MS) {
    const totalMinutes = Math.round(remainingMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutesLeft = totalMinutes % 60;
    return hours === 0 ? `in ${minutesLeft}m` : `in ${hours}h${minutesLeft}m`;
  }
  const weekday = resetsAt.toLocaleDateString('en-US', { weekday: 'short' });
  const time = resetsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${weekday} ${time}`;
}

export function shouldUseColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean {
  return Boolean(stream.isTTY) && env.NO_COLOR === undefined;
}

interface Row {
  account: string;
  limit: string;
  used: string;
  resets: string;
  color?: string;
}

function formatUsed(limit: Limit): string {
  if (limit.percent === null) return limit.detail ?? 'n/a';
  const clamped = Math.min(100, Math.max(0, limit.percent));
  const filled = Math.round(clamped / (100 / BAR_CELLS));
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled);
  const percentText = `${String(Math.round(limit.percent)).padStart(3)} %`;
  const marker = limit.severity === 'critical' ? '  !' : '';
  return `${bar} ${percentText}${marker}`;
}

function rowsFor(usage: AccountUsage, now: Date): Row[] {
  const id = accountId(usage.account);
  if (usage.status === 'error') {
    const hint = usage.hint ? ` — run: ${usage.hint}` : '';
    return [{ account: id, limit: 'unavailable', used: `${usage.message}${hint}`, resets: '', color: ANSI.dim }];
  }
  if (usage.limits.length === 0) {
    return [{ account: id, limit: '', used: 'no limits reported', resets: '', color: ANSI.dim }];
  }
  return usage.limits.map((limit, index) => ({
    account: index === 0 ? id : '',
    limit: limit.label,
    used: formatUsed(limit),
    resets: formatReset(limit.resetsAt, now),
    color: SEVERITY_COLOR[limit.severity],
  }));
}

export function renderTable(usages: AccountUsage[], now: Date, options: { color: boolean }): string {
  const header: Row = { account: 'Account', limit: 'Limit', used: 'Used', resets: 'Resets' };
  const rows = usages.flatMap((usage) => rowsFor(usage, now));
  const all = [header, ...rows];
  const width = (key: keyof Omit<Row, 'color'>) => Math.max(...all.map((row) => row[key].length));
  const widths = { account: width('account'), limit: width('limit'), used: width('used') };

  const paint = (text: string, color: string | undefined) =>
    options.color && color ? `${color}${text}${ANSI.reset}` : text;

  const line = (row: Row, isHeader: boolean) => {
    const used = row.used.padEnd(widths.used);
    const text = [
      row.account.padEnd(widths.account),
      row.limit.padEnd(widths.limit),
      paint(used, isHeader ? ANSI.bold : row.color),
      row.resets,
    ].join('  ');
    return text.trimEnd();
  };

  return [line(header, true), ...rows.map((row) => line(row, false))].join('\n');
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
        percent: limit.percent,
        resetsAt: limit.resetsAt ? limit.resetsAt.toISOString() : null,
        severity: limit.severity,
        ...(limit.detail ? { detail: limit.detail } : {}),
      })),
    };
  });
  return JSON.stringify({ generatedAt: now.toISOString(), accounts }, null, 2);
}
