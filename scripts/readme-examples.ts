/**
 * Renders the README examples: the default output for typical situations, drawn as terminal-style SVGs
 * in docs/examples/, so the README shows the colours GitHub strips from code blocks.
 * Run `npm run docs:examples` after changing the output; tests/readme-examples.test.ts fails while the
 * committed SVGs are out of date.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderOverview } from '../src/render.ts';
import type { ToolStatus } from '../src/tools.ts';
import { severityForPercent, type AccountUsage, type Limit, type LimitKind, type ProviderId } from '../src/types.ts';

const NOW = new Date('2026-11-19T19:42:00Z');
const at = (hours: number | null) => (hours === null ? null : new Date(NOW.getTime() + hours * 3_600_000));
const DAY = 24;

const limit = (label: string, kind: LimitKind, percent: number, hours: number | null): Limit => ({
  label,
  kind,
  percent,
  resetsAt: at(hours),
  severity: severityForPercent(percent),
});
const session = (percent: number, hours: number | null) => limit('5h', 'session', percent, hours);
const week = (percent: number, hours: number | null) => limit('Week (all)', 'weekly', percent, hours);
const fable = (percent: number, hours: number | null) => limit('Week (Fable)', 'model', percent, hours);
const chatgptWeek = (percent: number, hours: number | null) => limit('Week', 'weekly', percent, hours);
const astra = (percent: number | 'blocked', hours: number | null): Limit =>
  percent === 'blocked'
    ? { label: 'gpt-6-astra', kind: 'model', percent: null, resetsAt: at(hours), severity: 'critical', detail: 'blocked' }
    : limit('gpt-6-astra', 'model', percent, hours);

const ok = (provider: ProviderId, label: string, limits: Limit[]): AccountUsage => ({ account: { provider, label }, status: 'ok', limits });
const failed = (provider: ProviderId, label: string, message: string, hint?: string): AccountUsage => ({
  account: { provider, label },
  status: 'error',
  message,
  ...(hint ? { hint } : {}),
});

// Deadlines shared by the examples: one account resets within a day, one in 4 days, one in almost 7.
const SOON = 22 + 18 / 60;
const MID = 4 * DAY + 18 / 60;
const LATE = 6 * DAY + 19 + 18 / 60;
const SESSION = 4 + 38 / 60;
const CHATGPT = DAY + 37 / 60;

export interface Example {
  file: string;
  usages: AccountUsage[];
  tools?: ToolStatus[];
}

export const EXAMPLES: Example[] = [
  {
    file: 'typical.svg',
    usages: [
      ok('claude', 'work@example.com', [session(3, SESSION), week(9, LATE), fable(0, LATE)]),
      ok('claude', 'team@example.com', [session(0, null), week(79, MID), fable(100, MID)]),
      ok('claude', 'me@example.com', [session(20, SESSION), week(78, SOON), fable(100, SOON)]),
      ok('chatgpt', 'pro@example.com', [chatgptWeek(100, CHATGPT), astra('blocked', CHATGPT)]),
    ],
  },
  {
    file: 'session-full.svg',
    usages: [
      ok('claude', 'me@example.com', [session(100, SESSION), week(78, SOON), fable(100, SOON)]),
      ok('claude', 'team@example.com', [session(0, null), week(79, MID), fable(100, MID)]),
      ok('claude', 'work@example.com', [session(3, SESSION), week(9, LATE), fable(0, LATE)]),
      ok('chatgpt', 'pro@example.com', [chatgptWeek(35, CHATGPT), astra(20, CHATGPT)]),
    ],
  },
  {
    file: 'weekly-used-up.svg',
    usages: [
      ok('claude', 'me@example.com', [session(30, 2.4), week(60, SOON), fable(100, SOON)]),
      ok('claude', 'team@example.com', [session(0, null), week(100, MID), fable(100, MID)]),
      ok('claude', 'work@example.com', [session(3, SESSION), week(9, LATE), fable(0, LATE)]),
    ],
  },
  {
    file: 'lapse-risk.svg',
    usages: [
      ok('claude', 'work@example.com', [session(3, SESSION), week(9, LATE), fable(0, LATE)]),
      ok('claude', 'me@example.com', [session(10, 4), week(35, 9), fable(40, 9)]),
      ok('claude', 'team@example.com', [session(0, null), week(30, 40), fable(100, 40)]),
    ],
  },
  {
    file: 'nothing-usable.svg',
    usages: [
      ok('claude', 'me@example.com', [session(100, SESSION), week(78, SOON), fable(100, SOON)]),
      ok('claude', 'team@example.com', [session(0, null), week(100, MID), fable(100, MID)]),
      ok('claude', 'work@example.com', [session(100, 2.2), week(40, LATE), fable(15, LATE)]),
      ok('chatgpt', 'pro@example.com', [chatgptWeek(35, CHATGPT), astra(20, CHATGPT)]),
    ],
  },
  {
    file: 'errors.svg',
    usages: [
      ok('claude', 'me@example.com', [session(20, SESSION), week(78, SOON), fable(100, SOON)]),
      failed('claude', 'team@example.com', 'Login expired', 'aiu login claude --name team@example.com'),
      ok('claude', 'work@example.com', [session(3, SESSION), week(30, null), fable(0, null)]),
      ok('chatgpt', 'pro@example.com', [chatgptWeek(35, CHATGPT), astra(20, CHATGPT)]),
      failed('grok', 'main', 'Unavailable (blocked)'),
    ],
  },
  {
    file: 'tools.svg',
    usages: [
      ok('claude', 'me@example.com', [session(20, SESSION), week(78, SOON), fable(100, SOON)]),
      ok('chatgpt', 'pro@example.com', [chatgptWeek(35, CHATGPT), astra(20, CHATGPT)]),
    ],
    tools: [
      { id: 'claude', installed: '2.1.330', latest: '2.1.341', updateAvailable: true },
      { id: 'codex', installed: '0.171.0', latest: '0.173.0', updateAvailable: true },
      { id: 'grok', installed: '1.0.89', latest: '1.0.89', updateAvailable: false },
    ],
  },
];

// ---------- ANSI to SVG ----------

const FONT_SIZE = 13;
const CHAR_WIDTH = 7.8;
const LINE_HEIGHT = 19;
const PADDING = 16;
const FOREGROUND = '#d5dbd7';

interface Run {
  column: number;
  text: string;
  color: string;
  bold: boolean;
}

const hex = (value: string) => Number(value).toString(16).padStart(2, '0');

/**
 * Splits one line of the renderer's 24-bit output into styled runs, tracking the column each run starts
 * at. The colours come from the escape codes themselves, so the images show exactly what the CLI prints.
 */
function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  let color = FOREGROUND;
  let bold = false;
  let column = 0;
  for (const part of line.split(/(\x1b\[[\d;]+m)/)) {
    const code = part.match(/^\x1b\[([\d;]+)m$/)?.[1];
    if (code !== undefined) {
      const rgb = code.match(/^38;2;(\d+);(\d+);(\d+)$/);
      if (code === '0') [color, bold] = [FOREGROUND, false];
      else if (code === '1') bold = true;
      else if (rgb) color = `#${hex(rgb[1]!)}${hex(rgb[2]!)}${hex(rgb[3]!)}`;
      else throw new Error(`unexpected escape code ${JSON.stringify(code)}: render with color 'truecolor'`);
      continue;
    }
    if (part.length === 0) continue;
    runs.push({ column, text: part, color, bold });
    column += part.length;
  }
  return runs;
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Every run gets its own x and a fixed textLength, so columns line up whatever monospace font the
 * viewer falls back to, including for the block and arrow characters.
 */
export function toSvg(ansi: string): string {
  const lines = ansi.split('\n');
  const columns = Math.max(...lines.map((line) => line.replace(/\x1b\[[\d;]+m/g, '').length));
  const width = Math.ceil(columns * CHAR_WIDTH + 2 * PADDING);
  const height = Math.ceil(lines.length * LINE_HEIGHT + 2 * PADDING - (LINE_HEIGHT - FONT_SIZE));
  // Each word is placed on its own column: renderers that collapse spaces then cannot shift the rest.
  const texts = lines.flatMap((line, row) =>
    runsOf(line).flatMap((run) =>
      [...run.text.matchAll(/\S+/g)].map((word) => {
        const x = (PADDING + (run.column + word.index) * CHAR_WIDTH).toFixed(1);
        const y = (PADDING + FONT_SIZE + row * LINE_HEIGHT - 3).toFixed(1);
        const length = (word[0].length * CHAR_WIDTH).toFixed(1);
        const weight = run.bold ? ' font-weight="700"' : '';
        return `<text x="${x}" y="${y}" textLength="${length}" lengthAdjust="spacingAndGlyphs" fill="${run.color}"${weight}>${escapeXml(word[0])}</text>`;
      }),
    ),
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="8" fill="#121614"/>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}">`,
    ...texts,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

export const renderExample = (example: Example): string => toSvg(renderOverview(example.usages, NOW, { color: 'truecolor', ...(example.tools ? { tools: example.tools } : {}) }));

export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'examples');

if (import.meta.main) {
  mkdirSync(EXAMPLES_DIR, { recursive: true });
  for (const example of EXAMPLES) {
    writeFileSync(join(EXAMPLES_DIR, example.file), renderExample(example));
    console.log(`wrote docs/examples/${example.file}`);
  }
}
