import { byDeadline, findKind, freesUpAt, isUsedUp, modelName, recommend, SESSION_ROOM, type ProviderAdvice } from './recommend.ts';
import { accountId, type AccountUsage, type Limit, type ProviderId, type Severity } from './types.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SESSION_BAR_CELLS = 5;
const WEEK_BAR_CELLS = 10;
// % per hour needed to use up what is left of the weekly limit before it resets.
const PACE_TIGHT = 1.5;
const PACE_CRITICAL = 3;

/** What a piece of text means; how it looks depends on the colour mode (see `paintLine`). */
type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan' | 'boldGreen';

/**
 * Colour support of the output stream: none, the 8 basic terminal colours (their shades come from the
 * terminal's theme) or 24-bit colour, which shows exactly the shades of the README examples.
 */
export type ColorMode = 'none' | 'basic' | 'truecolor';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

/** The 24-bit shades: an orange rather than a lemon yellow, and a grey for dimmed text. */
export const TRUECOLOR_PALETTE = {
  red: '#f26161',
  green: '#5fcf8a',
  yellow: '#f2a03d',
  cyan: '#63c3d4',
  dim: '#6c7671',
} as const;

const rgb = (hex: string): string => {
  const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `\x1b[38;2;${red};${green};${blue}m`;
};

const STYLE_CODES: Record<Exclude<ColorMode, 'none'>, Record<Style, string>> = {
  basic: {
    bold: BOLD,
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    boldGreen: `${BOLD}\x1b[32m`,
  },
  truecolor: {
    bold: BOLD,
    dim: rgb(TRUECOLOR_PALETTE.dim),
    red: rgb(TRUECOLOR_PALETTE.red),
    green: rgb(TRUECOLOR_PALETTE.green),
    yellow: rgb(TRUECOLOR_PALETTE.yellow),
    cyan: rgb(TRUECOLOR_PALETTE.cyan),
    boldGreen: `${BOLD}${rgb(TRUECOLOR_PALETTE.green)}`,
  },
};

const SEVERITY_COLOR: Record<Severity, Style> = {
  normal: 'green',
  warning: 'yellow',
  critical: 'red',
};

const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' };

export function severityForPercent(percent: number): Severity {
  if (percent >= 80) return 'critical';
  if (percent >= 50) return 'warning';
  return 'normal';
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

export function colorMode(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): ColorMode {
  // no-color.org: only a non-empty NO_COLOR disables colour.
  if (!stream.isTTY || env.NO_COLOR) return 'none';
  // COLORTERM is how terminals announce 24-bit colour.
  return env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' ? 'truecolor' : 'basic';
}

/** "in 3h 9m", "now" for a moment that has already passed, or "at an unknown time". */
function inTime(at: Date | null, now: Date): string {
  if (!at) return 'at an unknown time';
  return at <= now ? 'now' : `in ${formatCountdown(at, now)}`;
}

// ---------- styled text ----------

interface Segment {
  text: string;
  style?: Style;
}
type Cell = Segment[];

const segment = (text: string, style?: Style): Segment => (style ? { text, style } : { text });
const cellWidth = (cell: Cell): number => cell.reduce((sum, part) => sum + part.text.length, 0);
const padCell = (cell: Cell, width: number): Cell => [...cell, segment(' '.repeat(Math.max(0, width - cellWidth(cell))))];
const joinNotes = (notes: Cell[]): Cell => notes.flatMap((note, index) => (index === 0 ? note : [segment(' · ', 'dim'), ...note]));

function paintLine(line: Cell, mode: ColorMode): string {
  const codes = mode === 'none' ? null : STYLE_CODES[mode];
  const text = line.map((part) => (codes && part.style && part.text ? `${codes[part.style]}${part.text}${RESET}` : part.text)).join('');
  return text.trimEnd();
}

// ---------- account rows ----------

type OkUsage = Extract<AccountUsage, { status: 'ok' }>;

/** Columns every provider section shares, so they line up across providers. */
interface DataRow {
  type: 'data';
  glyph: Cell;
  account: Cell;
  session: Cell;
  week: Cell;
  /** One cell per model column of the provider (see `extraKey`). */
  extras: Cell[];
  resetsIn: Cell;
  burn: Cell;
  note: Cell;
}

/** A row whose text runs across the limit columns: an error or an account without limits. */
interface SpanRow {
  type: 'span';
  glyph: Cell;
  account: Cell;
  message: Cell;
}

type Row = DataRow | SpanRow;

interface Section {
  name: string;
  header: DataRow | null;
  rows: Row[];
  /** Accounts with weekly allowance left, in burn order. */
  burnable: AccountState[];
  hasSession: boolean;
}

/** Model limits group by model ("Week (Fable)" → "Fable"); limits of unknown kind keep their label. */
const extraKey = (limit: Limit): string | null => {
  if (limit.kind === 'model') return modelName(limit.label);
  return limit.kind ? null : limit.label;
};

function pace(weekly: Limit, pausedUntil: Date | null, now: Date): number | null {
  if (weekly.percent === null || !weekly.resetsAt) return null;
  const start = pausedUntil && pausedUntil > now ? pausedUntil : now;
  const hours = Math.max((weekly.resetsAt.getTime() - start.getTime()) / HOUR_MS, 1 / 60);
  return Math.max(0, 100 - weekly.percent) / hours;
}

const paceColor = (value: number | null): Style =>
  value === null ? 'dim' : value > PACE_CRITICAL ? 'red' : value >= PACE_TIGHT ? 'yellow' : 'green';

const percentText = (percent: number): string => `${String(Math.floor(percent)).padStart(3)} %`;

function bar(percent: number, cells: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round(clamped / (100 / cells));
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

/** A used-up limit is always red; on a row that waits for its weekly reset everything else is dimmed. */
const limitStyle = (limit: Limit, dimmed: boolean): Style =>
  isUsedUp(limit) ? 'red' : dimmed ? 'dim' : SEVERITY_COLOR[limit.severity];

function limitCell(limit: Limit | undefined, cells: number, dimmed: boolean): Cell {
  if (!limit) return [segment('—', 'dim')];
  const style = limitStyle(limit, dimmed);
  if (limit.percent === null) return [segment(limit.detail ?? 'n/a', isUsedUp(limit) ? 'red' : dimmed ? 'dim' : undefined)];
  return [segment(`${bar(limit.percent, cells)} ${percentText(limit.percent)}`, style)];
}

/** The latest reset of these limits, or null when any of them is unknown. */
function latestReset(limits: Limit[]): Date | null {
  if (limits.length === 0 || limits.some((limit) => limit.resetsAt === null)) return null;
  return limits.reduce<Date | null>((latest, limit) => (!latest || limit.resetsAt! > latest ? limit.resetsAt : latest), null);
}

/**
 * A model column: its fullest limit, or "✗" when one is used up. A used-up model that comes back at
 * another time than the row's weekly reset (ChatGPT's "GPT-6 Pro 5h", "gpt-6-astra") shows when, and one
 * without a known reset says so rather than implying it comes back with the week.
 */
function extraCell(limits: Limit[], dimmed: boolean, weeklyReset: Date | null, now: Date): Cell {
  if (limits.length === 0) return [];
  const usedUp = limits.filter(isUsedUp);
  if (usedUp.length > 0) {
    const back = latestReset(usedUp);
    if (back === null) return [segment('✗ unknown', 'red')];
    const ownReset = (!weeklyReset || Math.abs(back.getTime() - weeklyReset.getTime()) > 60_000);
    return [segment(ownReset ? `✗ ${formatCountdown(back, now)}` : '✗ used', 'red')];
  }
  const known = limits.filter((limit) => limit.percent !== null);
  if (known.length === 0) return [segment(limits[0]!.detail ?? 'n/a', dimmed ? 'dim' : undefined)];
  const fullest = known.reduce((max, limit) => (limit.percent! > max.percent! ? limit : max));
  return [segment(percentText(fullest.percent!), limitStyle(fullest, dimmed))];
}

/** The weekly reset as recommend.ts orders by it: no weekly limit counts like an unknown reset, i.e. last. */
const deadline = (state: AccountState): Pick<Limit, 'resetsAt'> => ({ resetsAt: state.weekly?.resetsAt ?? null });

/** When a waiting account can be used again: the reset of its full or nearly full 5h window, or of a used-up limit of unknown kind. */
function waitsUntil(state: AccountState): Date | null {
  const { session, usage } = state;
  const sessionWaits = session !== undefined && (isUsedUp(session) || (session.percent !== null && 100 - session.percent < SESSION_ROOM));
  return latestReset([...(sessionWaits ? [session] : []), ...usage.limits.filter((limit) => !limit.kind && isUsedUp(limit))]);
}

interface AccountState {
  usage: OkUsage;
  session?: Limit;
  weekly?: Limit;
  weeklyUsedUp: boolean;
  /** 5h window used up, under SESSION_ROOM % left, or a used-up limit of unknown kind. */
  paused: boolean;
}

function stateOf(usage: OkUsage): AccountState {
  const session = findKind(usage, 'session');
  const weekly = findKind(usage, 'weekly');
  const sessionLow = session !== undefined && session.percent !== null && 100 - session.percent < SESSION_ROOM;
  const unknownUsedUp = usage.limits.some((limit) => !limit.kind && isUsedUp(limit));
  return {
    usage,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    weeklyUsedUp: weekly !== undefined && isUsedUp(weekly),
    paused: (session !== undefined && isUsedUp(session)) || sessionLow || unknownUsedUp,
  };
}

function notesFor(state: AccountState, premium: string[], now: Date): Cell {
  const { session, weekly, usage } = state;
  const notes: Cell[] = [];
  if (state.weeklyUsedUp) {
    const back = freesUpAt(usage);
    return joinNotes([[segment(back ? `week used up · back ${inTime(back, now)}` : 'week used up', 'red')]]);
  }
  if (session && isUsedUp(session)) {
    notes.push([segment(session.resetsAt ? `${session.label} back ${inTime(session.resetsAt, now)}` : `${session.label} used up`, 'yellow')]);
  } else if (session && session.percent !== null && 100 - session.percent < SESSION_ROOM) {
    notes.push([segment(`${session.label} ${Math.floor(100 - session.percent)} % left`, 'yellow')]);
  }
  for (const limit of usage.limits.filter((candidate) => !candidate.kind && isUsedUp(candidate))) {
    notes.push([segment(`${limit.label} used up`, 'yellow')]);
  }
  if (weekly && weekly.percent !== null) {
    const pausedUntil = session && isUsedUp(session) ? session.resetsAt : null;
    const value = pace(weekly, pausedUntil, now);
    if (value !== null && value >= PACE_TIGHT) notes.push([segment(`needs ${value.toFixed(1)} %/h`, paceColor(value))]);
    if (!weekly.resetsAt) notes.push([segment('reset unknown', 'dim')]);
  }
  for (const model of premium) notes.push([segment(`${model} first`, 'cyan')]);
  return joinNotes(notes);
}

function dataRow(state: AccountState, extras: string[], recommended: boolean, premium: string[], now: Date): DataRow {
  const { usage, session, weekly, weeklyUsedUp, paused } = state;
  const glyph = recommended
    ? [segment('▶', 'boldGreen')]
    : weeklyUsedUp
      ? [segment('✗', 'red')]
      : paused
        ? [segment('‖', 'yellow')]
        : [segment(' ')];
  const pausedUntil = session && isUsedUp(session) ? session.resetsAt : null;
  const burn = (): Cell => {
    if (weeklyUsedUp || !weekly || weekly.percent === null) return [segment('—', 'dim')];
    return [segment(percentText(Math.max(0, 100 - weekly.percent)), paceColor(pace(weekly, pausedUntil, now)))];
  };
  const resetsIn = !weekly ? '—' : weekly.resetsAt ? formatCountdown(weekly.resetsAt, now) : 'unknown';
  return {
    type: 'data',
    glyph,
    account: [segment(usage.account.label, recommended ? 'bold' : weeklyUsedUp ? 'dim' : undefined)],
    session: limitCell(session, SESSION_BAR_CELLS, weeklyUsedUp),
    week: limitCell(weekly, WEEK_BAR_CELLS, weeklyUsedUp),
    extras: extras.map((key) => extraCell(usage.limits.filter((limit) => extraKey(limit) === key), weeklyUsedUp, weekly?.resetsAt ?? null, now)),
    resetsIn: [segment(resetsIn, weeklyUsedUp || !weekly ? 'dim' : undefined)],
    burn: burn(),
    note: notesFor(state, premium, now),
  };
}

/**
 * One provider's accounts in the order to burn them: accounts with weekly allowance left by weekly reset
 * (accounts waiting for their 5h window keep their place), then accounts whose weekly limit is used up,
 * by when they free up, then accounts without limits and accounts that failed.
 */
function providerSection(provider: ProviderId, usages: AccountUsage[], advice: ProviderAdvice | undefined, now: Date): Section {
  const name = PROVIDER_NAMES[provider];
  const ok = usages.filter((usage): usage is OkUsage => usage.status === 'ok' && usage.limits.length > 0).map(stateOf);
  const spans: SpanRow[] = usages.flatMap((usage): SpanRow[] => {
    const account = [segment(usage.account.label, 'dim')];
    if (usage.status === 'error') {
      const hint = usage.hint ? [segment(` — run: ${usage.hint}`, 'dim')] : [];
      return [{ type: 'span', glyph: [segment('!', 'red')], account, message: [segment(usage.message, 'red'), ...hint] }];
    }
    if (usage.limits.length === 0) return [{ type: 'span', glyph: [segment(' ')], account, message: [segment('no limits reported', 'dim')] }];
    return [];
  });
  const freeAt = (state: AccountState): Pick<Limit, 'resetsAt'> => ({ resetsAt: freesUpAt(state.usage) });
  const burnable = ok.filter((state) => !state.weeklyUsedUp).sort((first, second) => byDeadline(deadline(first), deadline(second)));
  const usedUp = ok.filter((state) => state.weeklyUsedUp).sort((first, second) => byDeadline(freeAt(first), freeAt(second)));

  const extras = [...new Set(ok.flatMap((state) => state.usage.limits.map(extraKey).filter((key) => key !== null)))];
  // Each model with room is suggested once: on the first account in burn order that still has it.
  const premiumFor = new Map<AccountState, string[]>();
  for (const model of extras.filter((key) => ok.some((state) => state.usage.limits.some((limit) => limit.kind === 'model' && modelName(limit.label) === key)))) {
    const first = burnable.find((state) => {
      const limits = state.usage.limits.filter((limit) => limit.kind === 'model' && modelName(limit.label) === model);
      return limits.length > 0 && !limits.some(isUsedUp);
    });
    if (first) premiumFor.set(first, [...(premiumFor.get(first) ?? []), model]);
  }

  const recommendedId = advice?.accountId ?? null;
  const rows: Row[] = [...burnable, ...usedUp].map((state) =>
    dataRow(state, extras, accountId(state.usage.account) === recommendedId, premiumFor.get(state) ?? [], now),
  );
  const sessionLabel = ok.find((state) => state.session)?.session?.label ?? '5h';
  const bold = (text: string) => [segment(text, 'bold')];
  const header: DataRow | null =
    ok.length === 0
      ? null
      : {
          type: 'data',
          glyph: [],
          account: bold(name),
          session: bold(sessionLabel),
          week: bold('Week'),
          extras: extras.map(bold),
          resetsIn: bold('Resets in'),
          burn: bold('Burn'),
          note: [],
        };
  return { name, header, rows: [...rows, ...spans], burnable, hasSession: ok.some((state) => state.session) };
}

/** All sections share one set of column widths, so 5h, Week, Resets in and Burn line up across providers. */
function sectionLines(sections: Section[]): Cell[][] {
  const dataRows = sections.flatMap((section) => [...(section.header ? [section.header] : []), ...section.rows.filter((row): row is DataRow => row.type === 'data')]);
  const allRows = sections.flatMap((section) => section.rows);
  const hasSession = sections.some((section) => section.hasSession);
  const extraSlots = Math.max(0, ...dataRows.map((row) => row.extras.length));
  const widthOf = (pick: (row: DataRow) => Cell) => Math.max(0, ...dataRows.map((row) => cellWidth(pick(row))));
  const widths = {
    glyph: 1,
    account: Math.max(widthOf((row) => row.account), ...allRows.map((row) => cellWidth(row.account)), ...sections.map((section) => section.name.length)),
    session: widthOf((row) => row.session),
    week: widthOf((row) => row.week),
    extras: Array.from({ length: extraSlots }, (_, index) => widthOf((row) => row.extras[index] ?? [])),
    resetsIn: widthOf((row) => row.resetsIn),
    burn: widthOf((row) => row.burn),
  };
  const lead = (row: Row): Cell => [...padCell(row.glyph, widths.glyph), segment(' '), ...padCell(row.account, widths.account), segment('  ')];
  const line = (row: Row): Cell => {
    if (row.type === 'span') return [...lead(row), ...row.message];
    const columns: Cell[] = [
      ...(hasSession ? [padCell(row.session, widths.session)] : []),
      padCell(row.week, widths.week),
      ...widths.extras.map((width, index) => padCell(row.extras[index] ?? [], width)),
      padCell(row.resetsIn, widths.resetsIn),
      padCell(row.burn, widths.burn),
      row.note,
    ];
    return [...lead(row), ...columns.flatMap((cell, index) => (index === 0 ? cell : [segment('  '), ...cell]))];
  };
  return sections.map((section) => [
    ...(section.header ? [line(section.header)] : [[segment('  '), segment(section.name, 'bold')]]),
    ...section.rows.map(line),
  ]);
}

// ---------- "Use now" ----------

function useNowLine(name: string, advice: ProviderAdvice | undefined, usages: AccountUsage[], burnable: AccountState[], now: Date): Cell {
  const labelOf = (id: string | undefined) => usages.find((usage) => accountId(usage.account) === id)?.account.label ?? id ?? '';
  const lead = (glyph: Segment) => [glyph, segment(' '), segment(name, 'bold')];
  if (!advice) return [...lead(segment('✗', 'red')), segment('  '), segment('no data: every account failed', 'red')];
  if (advice.noData) return [...lead(segment('✗', 'red')), segment('  '), segment('no 5h or weekly limit data to recommend from', 'dim')];
  if (advice.accountId === null) {
    const where = advice.availableAccountId ? [segment(' on '), segment(labelOf(advice.availableAccountId), 'bold')] : [];
    return [...lead(segment('✗', 'red')), segment('  '), segment('nothing usable', 'red'), segment(` — back ${inTime(advice.availableAt ?? null, now)}`), ...where];
  }
  const recommended = burnable.find((state) => accountId(state.usage.account) === advice.accountId);
  const parts: Cell = [...lead(segment('▶', 'boldGreen')), segment('  use '), segment(labelOf(advice.accountId), 'bold')];
  const details: Cell[] = [];
  if (advice.weeklyLeft !== undefined) {
    const left = Math.floor(advice.weeklyLeft);
    const weekly = recommended?.weekly;
    const style = weekly ? paceColor(pace(weekly, null, now)) : undefined;
    details.push([segment(advice.weeklyResetsAt ? `${left} % lapses ${inTime(advice.weeklyResetsAt, now)}` : `${left} % left, reset unknown`, style)]);
  }
  if (advice.sessionLeft !== undefined) details.push([segment(`${advice.sessionLabel ?? '5h'} ${Math.floor(advice.sessionLeft)} % free`)]);
  // An account due earlier that waits for its 5h window: say when to switch back to it.
  const recommendedIndex = recommended ? burnable.indexOf(recommended) : -1;
  const waiting = burnable.slice(0, Math.max(0, recommendedIndex)).find((state) => state.paused && byDeadline(deadline(state), deadline(recommended!)) < 0);
  if (waiting) {
    const until = waitsUntil(waiting);
    const when = until ? inTime(until, now) : 'when it frees up';
    details.push([segment(`back to ${waiting.usage.account.label} ${when}`, 'yellow')]);
  }
  return details.length === 0 ? parts : [...parts, segment(' — '), ...details.flatMap((detail, index) => (index === 0 ? detail : [segment(' · '), ...detail]))];
}

/**
 * The default output: per provider, which account to use now, then every account in the order to burn its
 * weekly allowance (see recommend.ts), with its limits, time to the weekly reset and how much is left.
 */
export function renderOverview(usages: AccountUsage[], now: Date, options: { color: ColorMode }): string {
  const advice = recommend(usages, now);
  const providers = [...new Set(usages.map((usage) => usage.account.provider))];
  const byProvider = (provider: ProviderId) => usages.filter((usage) => usage.account.provider === provider);
  const adviceFor = (provider: ProviderId) => advice.providers.find((entry) => entry.provider === provider);
  const sections = providers.map((provider) => providerSection(provider, byProvider(provider), adviceFor(provider), now));
  const nameWidth = Math.max(...sections.map((section) => section.name.length));
  const indent = (line: Cell): Cell => (line.length === 0 ? line : [segment('  '), ...line]);
  const heading = (title: string, subtitle: string): Cell => [segment(title, 'bold'), segment(`  ${subtitle}`, 'dim')];
  const lines: Cell[] = [
    heading('Use now', 'which account to work on right now'),
    ...providers.map((provider, index) =>
      indent(useNowLine(sections[index]!.name.padEnd(nameWidth), adviceFor(provider), byProvider(provider), sections[index]!.burnable, now)),
    ),
    [],
    heading('Accounts', 'burn top to bottom: earliest weekly reset first'),
    ...sectionLines(sections).flatMap((section, index) => [...(index > 0 ? [[]] : []), ...section.map(indent)]),
  ];
  return lines.map((line) => paintLine(line, options.color)).join('\n');
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
