import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './store/accounts.ts';

/** The CLI tools that belong to the subscriptions, in display order. */
export const TOOL_IDS = ['claude', 'codex', 'grok'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export interface ToolStatus {
  id: ToolId;
  installed: string;
  /** `null` when the latest version could not be found out. */
  latest: string | null;
  updateAvailable: boolean;
}

export interface CommandResult {
  /** The exit code; `null` when the command could not start or timed out. */
  code: number | null;
  /** stdout followed by stderr. */
  output: string;
}

export interface ToolDeps {
  run: (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
  fetch: typeof fetch;
  now: () => Date;
  cacheDir: () => string;
}

export type UpdateOutcome =
  | { id: ToolId; status: 'updated'; from: string; to: string }
  | { id: ToolId; status: 'current'; version: string }
  | { id: ToolId; status: 'failed'; version: string; reason: string }
  | { id: ToolId; status: 'missing' };

const CHECK_TIMEOUT_MS = 3_000;
export const UPDATE_TIMEOUT_MS = 300_000;
const CACHE_TTL_MS = 24 * 3_600_000;
const CACHE_FILE = 'tool-versions.json';
const VERSION_PATTERN = /\d+(?:\.\d+)+/;

type LatestSource = { npmPackage: string } | { command: string[]; field: string };

const LATEST_SOURCES: Record<ToolId, LatestSource> = {
  claude: { npmPackage: '@anthropic-ai/claude-code' },
  codex: { npmPackage: '@openai/codex' },
  grok: { command: ['update', '--check', '--json'], field: 'latestVersion' },
};

// The service is called chatgpt in `aiu login`; its tool is codex.
const ALIASES = new Map<string, ToolId>([['chatgpt', 'codex']]);

export const resolveToolId = (name: string): ToolId | undefined =>
  (TOOL_IDS as readonly string[]).includes(name) ? (name as ToolId) : ALIASES.get(name);

const runCommand: ToolDeps['run'] = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (!error) return resolve({ code: 0, output });
      // A string code (ENOENT) means the command never ran; a killed child timed out.
      resolve({ code: typeof error.code === 'number' && !error.killed ? error.code : null, output });
    });
    // No tool gets to wait for input it will never receive.
    child.stdin?.end();
  });

export const defaultToolDeps = (): ToolDeps => ({
  run: runCommand,
  fetch: (...args) => fetch(...args),
  now: () => new Date(),
  cacheDir: configDir,
});

/** Compares dotted version numbers part by part; a missing part counts as 0. */
export function isNewer(candidate: string, installed: string): boolean {
  const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(candidate), parts(installed)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

const versionIn = (text: unknown): string | null => (typeof text === 'string' ? (text.match(VERSION_PATTERN)?.[0] ?? null) : null);

async function installedVersion(id: ToolId, deps: ToolDeps): Promise<string | null> {
  const result = await deps.run(id, ['--version'], CHECK_TIMEOUT_MS);
  return result.code === 0 ? versionIn(result.output) : null;
}

async function fetchLatest(id: ToolId, deps: ToolDeps): Promise<string | null> {
  const source = LATEST_SOURCES[id];
  if ('npmPackage' in source) {
    const response = await deps.fetch(`https://registry.npmjs.org/${source.npmPackage}/latest`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return versionIn(((await response.json()) as { version?: unknown } | null)?.version);
  }
  const result = await deps.run(id, source.command, CHECK_TIMEOUT_MS);
  if (result.code !== 0) return null;
  return versionIn((JSON.parse(result.output) as Record<string, unknown> | null)?.[source.field]);
}

type Cache = Partial<Record<ToolId, { latest: string; checkedAt: string }>>;

const cacheFile = (deps: ToolDeps): string => join(deps.cacheDir(), CACHE_FILE);

/** The cache is only a shortcut: anything unreadable or misshapen counts as empty. */
async function readCache(deps: ToolDeps): Promise<Cache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cacheFile(deps), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(([id, entry]) => {
      if (resolveToolId(id) !== id || entry === null || typeof entry !== 'object') return false;
      const { latest, checkedAt } = entry as Record<string, unknown>;
      return typeof latest === 'string' && VERSION_PATTERN.test(latest) && typeof checkedAt === 'string';
    });
    return Object.fromEntries(entries) as Cache;
  } catch {
    return {};
  }
}

async function writeCache(deps: ToolDeps, cache: Cache): Promise<void> {
  try {
    await mkdir(deps.cacheDir(), { recursive: true, mode: 0o700 });
    const temporaryFile = `${cacheFile(deps)}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFile, cacheFile(deps));
  } catch {
    // Without the cache the next run simply checks again.
  }
}

const isFresh = (checkedAt: string, now: Date): boolean => {
  const age = now.getTime() - new Date(checkedAt).getTime();
  return age >= 0 && age < CACHE_TTL_MS;
};

/**
 * The installed tools with their installed and latest version. A tool that is not installed is left out;
 * a latest version that cannot be found out is `null`. Never throws: the check must not fail `aiu`.
 * `fresh` ignores the cached latest versions (they are still written back).
 */
export async function inspectTools(deps: ToolDeps, options: { fresh?: boolean; only?: ToolId[] } = {}): Promise<ToolStatus[]> {
  const ids = TOOL_IDS.filter((id) => !options.only || options.only.includes(id));
  const cache = await readCache(deps);
  const fetched: Cache = {};
  const statuses = await Promise.all(
    ids.map(async (id): Promise<ToolStatus | null> => {
      const installed = await installedVersion(id, deps).catch(() => null);
      if (installed === null) return null;
      const cached = cache[id];
      const useCached = !options.fresh && cached !== undefined && isFresh(cached.checkedAt, deps.now());
      const latest = useCached ? cached.latest : await fetchLatest(id, deps).catch(() => null);
      if (!useCached && latest !== null) fetched[id] = { latest, checkedAt: deps.now().toISOString() };
      return { id, installed, latest, updateAvailable: latest !== null && isNewer(latest, installed) };
    }),
  );
  // Re-read before writing, so a parallel run's entries for other tools survive.
  if (Object.keys(fetched).length > 0) await writeCache(deps, { ...(await readCache(deps)), ...fetched });
  return statuses.filter((status) => status !== null);
}

// Terminal control sequences a tool prints for its own display: OSC (window title, links), CSI (colour,
// cursor) and two-character escapes, then any control character left over.
const CONTROL_SEQUENCES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-_]/g;
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The last thing the tool printed, as plain text: a line redrawn with `\r` counts by its final state. */
const lastLine = (output: string): string | undefined =>
  output
    .replace(CONTROL_SEQUENCES, '')
    .replace(CONTROL_CHARACTERS, '')
    .split(/[\r\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

/**
 * Updates one tool with its own `update` command. A tool known to be up to date is not run. The outcome
 * comes from the installed version before and after, not from what the tool prints.
 */
export async function updateTool(id: ToolId, deps: ToolDeps): Promise<UpdateOutcome> {
  const [status] = await inspectTools(deps, { fresh: true, only: [id] });
  if (!status) return { id, status: 'missing' };
  if (status.latest !== null && !status.updateAvailable) return { id, status: 'current', version: status.installed };

  const result = await deps.run(id, ['update'], UPDATE_TIMEOUT_MS);
  // Whatever happened, the cached latest version may no longer describe this tool.
  const { [id]: _dropped, ...rest } = await readCache(deps);
  await writeCache(deps, rest);
  // A timeout would otherwise be reported with whatever progress line the tool printed last.
  if (result.code === null) return { id, status: 'failed', version: status.installed, reason: 'timed out or could not start' };
  if (result.code !== 0) {
    return { id, status: 'failed', version: status.installed, reason: lastLine(result.output) ?? `exit code ${result.code}` };
  }
  const after = await installedVersion(id, deps).catch(() => null);
  // Without the new version there is nothing to tell an update from a no-op.
  if (after === null) return { id, status: 'failed', version: status.installed, reason: 'could not read the version after the update' };
  if (after !== status.installed) return { id, status: 'updated', from: status.installed, to: after };
  // The tool said it succeeded but stayed on a version known to be behind (e.g. it follows a slower
  // release channel): saying "already latest" would contradict the Tools section.
  if (status.updateAvailable) return { id, status: 'failed', version: after, reason: `not updated, latest is ${status.latest}` };
  return { id, status: 'current', version: after };
}
