import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectTools, isNewer, resolveToolId, updateTool, UPDATE_TIMEOUT_MS, type CommandResult, type ToolDeps } from '../src/tools.ts';

const NOW = new Date('2026-11-22T12:00:00Z');
const HOUR_MS = 3_600_000;

let dir: string;
let now: Date;
/** What `<tool> --version` prints; a missing key means the tool is not installed. */
let installed: Record<string, string>;
/** The registry's latest version per npm package; an Error makes the request fail. */
let registry: Record<string, string | Error | object>;
let grokCheck: CommandResult;
/** What `<tool> update` does: its result, and the version installed afterwards. */
let updates: Record<string, { result: CommandResult; installs?: string }>;
let commands: string[];
let requests: string[];

const ok = (output: string): CommandResult => ({ code: 0, output });

function deps(): ToolDeps {
  return {
    run: async (command, args, timeoutMs) => {
      commands.push(`${command} ${args.join(' ')} @${timeoutMs}`);
      if (args[0] === '--version') return command in installed ? ok(installed[command]!) : { code: null, output: '' };
      if (command === 'grok' && args.join(' ') === 'update --check --json') return grokCheck;
      if (args.join(' ') === 'update') {
        const update = updates[command]!;
        if (update.installs) installed[command] = update.installs;
        return update.result;
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
    fetch: (async (url: string) => {
      requests.push(url);
      const answer = registry[url.replace('https://registry.npmjs.org/', '').replace('/latest', '')];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) return new Response('not found', { status: 404 });
      return Response.json(typeof answer === 'string' ? { version: answer } : answer);
    }) as typeof fetch,
    now: () => now,
    cacheDir: () => dir,
  };
}

const cacheFile = () => join(dir, 'tool-versions.json');
const readCache = async () => JSON.parse(await readFile(cacheFile(), 'utf8')) as Record<string, { latest: string; checkedAt: string }>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-tools-'));
  now = NOW;
  installed = { claude: '2.1.330 (Claude Code)', codex: 'codex-cli 0.171.0', grok: 'grok 1.0.89 (28be5bb1bf65) [stable]' };
  registry = { '@anthropic-ai/claude-code': '2.1.341', '@openai/codex': '0.171.0' };
  grokCheck = ok(JSON.stringify({ currentVersion: '1.0.89', latestVersion: '1.0.92', updateAvailable: true }));
  updates = {};
  commands = [];
  requests = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isNewer', () => {
  it('compares dotted numbers, not strings', () => {
    expect(isNewer('2.1.341', '2.1.330')).toBe(true);
    expect(isNewer('1.0.10', '1.0.9')).toBe(true);
    expect(isNewer('1.0.9', '1.0.10')).toBe(false);
    expect(isNewer('2.1.330', '2.1.330')).toBe(false);
  });
  it('counts a missing part as 0', () => {
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.1', '1.2')).toBe(true);
  });
});

describe('resolveToolId', () => {
  it('knows the tools and the chatgpt alias', () => {
    expect(resolveToolId('claude')).toBe('claude');
    expect(resolveToolId('chatgpt')).toBe('codex');
    expect(resolveToolId('gemini')).toBeUndefined();
    expect(resolveToolId('toString')).toBeUndefined();
  });
});

describe('inspectTools', () => {
  it('reports the installed and the latest version of every tool', async () => {
    expect(await inspectTools(deps())).toEqual([
      { id: 'claude', installed: '2.1.330', latest: '2.1.341', updateAvailable: true },
      { id: 'codex', installed: '0.171.0', latest: '0.171.0', updateAvailable: false },
      { id: 'grok', installed: '1.0.89', latest: '1.0.92', updateAvailable: true },
    ]);
    expect(requests).toEqual([
      'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
      'https://registry.npmjs.org/@openai/codex/latest',
    ]);
  });

  it('leaves out a tool that is not installed, without asking for its latest version', async () => {
    delete installed.codex;
    expect((await inspectTools(deps())).map((tool) => tool.id)).toEqual(['claude', 'grok']);
    expect(requests).toHaveLength(1);
  });

  it('treats a tool whose --version fails or prints no version as not installed', async () => {
    installed.claude = 'something went wrong';
    const failing: ToolDeps = { ...deps(), run: async (command, args, timeoutMs) => (command === 'grok' ? { code: 1, output: '1.0.89' } : deps().run(command, args, timeoutMs)) };
    expect((await inspectTools(failing)).map((tool) => tool.id)).toEqual(['codex']);
  });

  it('survives a runner that throws', async () => {
    const throwing: ToolDeps = { ...deps(), run: async () => Promise.reject(new Error('spawn failed')) };
    expect(await inspectTools(throwing)).toEqual([]);
  });

  it('uses the cached latest versions for 24 hours', async () => {
    await inspectTools(deps());
    registry['@anthropic-ai/claude-code'] = '2.1.350';
    requests = [];
    commands = [];
    now = new Date(NOW.getTime() + 23 * HOUR_MS);
    expect((await inspectTools(deps()))[0]).toMatchObject({ latest: '2.1.341' });
    expect(requests).toEqual([]);
    expect(commands.filter((command) => command.includes('--check'))).toEqual([]);

    now = new Date(NOW.getTime() + 24 * HOUR_MS);
    expect((await inspectTools(deps()))[0]).toMatchObject({ latest: '2.1.350' });
  });

  it('ignores the cache when asked for fresh versions', async () => {
    await inspectTools(deps());
    registry['@anthropic-ai/claude-code'] = '2.1.350';
    expect((await inspectTools(deps(), { fresh: true }))[0]).toMatchObject({ latest: '2.1.350' });
    expect((await readCache()).claude?.latest).toBe('2.1.350');
  });

  it('checks only the tools asked for', async () => {
    expect((await inspectTools(deps(), { only: ['grok'] })).map((tool) => tool.id)).toEqual(['grok']);
    expect(requests).toEqual([]);
    expect(commands.some((command) => command.startsWith('claude'))).toBe(false);
  });

  it('shows no latest version when the check fails, and does not cache the failure', async () => {
    registry['@anthropic-ai/claude-code'] = new Error('offline');
    delete registry['@openai/codex'];
    grokCheck = { code: null, output: '' };
    expect(await inspectTools(deps())).toEqual([
      { id: 'claude', installed: '2.1.330', latest: null, updateAvailable: false },
      { id: 'codex', installed: '0.171.0', latest: null, updateAvailable: false },
      { id: 'grok', installed: '1.0.89', latest: null, updateAvailable: false },
    ]);
    await expect(readFile(cacheFile(), 'utf8')).rejects.toThrow();
  });

  it('shows no latest version when the answer has no usable version', async () => {
    registry['@anthropic-ai/claude-code'] = { name: 'claude-code' };
    registry['@openai/codex'] = { version: 42 };
    grokCheck = ok('not json');
    expect((await inspectTools(deps())).map((tool) => tool.latest)).toEqual([null, null, null]);
  });

  it('ignores a corrupt or misshapen cache file and rewrites it', async () => {
    await writeFile(cacheFile(), '{ not json');
    expect((await inspectTools(deps()))[0]).toMatchObject({ latest: '2.1.341' });
    expect((await readCache()).claude?.latest).toBe('2.1.341');

    await writeFile(cacheFile(), JSON.stringify({ claude: { latest: 7, checkedAt: NOW.toISOString() }, codex: 'x', other: {} }));
    expect((await inspectTools(deps())).map((tool) => tool.latest)).toEqual(['2.1.341', '0.171.0', '1.0.92']);
    expect(Object.keys(await readCache()).sort()).toEqual(['claude', 'codex', 'grok']);
  });

  it('counts an installed version ahead of the cached latest as up to date', async () => {
    await inspectTools(deps());
    installed.claude = '2.1.350 (Claude Code)';
    expect((await inspectTools(deps()))[0]).toEqual({ id: 'claude', installed: '2.1.350', latest: '2.1.341', updateAvailable: false });
  });

  it('gives every check a 3 second timeout', async () => {
    await inspectTools(deps());
    expect(commands.every((command) => command.endsWith('@3000'))).toBe(true);
  });
});

describe('updateTool', () => {
  it('runs the tool\'s own update and reports the version change', async () => {
    updates.claude = { result: ok('Successfully updated'), installs: '2.1.341 (Claude Code)' };
    expect(await updateTool('claude', deps())).toEqual({ id: 'claude', status: 'updated', from: '2.1.330', to: '2.1.341' });
    expect(commands).toContain(`claude update @${UPDATE_TIMEOUT_MS}`);
  });

  it('does not run a tool that is known to be up to date', async () => {
    expect(await updateTool('codex', deps())).toEqual({ id: 'codex', status: 'current', version: '0.171.0' });
    expect(commands.some((command) => command.startsWith('codex update'))).toBe(false);
  });

  it('checks the latest version afresh, whatever the cache says', async () => {
    await inspectTools(deps());
    registry['@openai/codex'] = '0.173.0';
    updates.codex = { result: ok('done'), installs: 'codex-cli 0.173.0' };
    expect(await updateTool('codex', deps())).toMatchObject({ status: 'updated', to: '0.173.0' });
  });

  it('runs the update when the latest version is unknown', async () => {
    registry['@anthropic-ai/claude-code'] = new Error('offline');
    updates.claude = { result: ok('') };
    expect(await updateTool('claude', deps())).toEqual({ id: 'claude', status: 'current', version: '2.1.330' });
    expect(commands).toContain(`claude update @${UPDATE_TIMEOUT_MS}`);
  });

  it('reports a version that did not change as already current', async () => {
    updates.grok = { result: ok('') };
    expect(await updateTool('grok', deps())).toEqual({ id: 'grok', status: 'current', version: '1.0.89' });
  });

  it('reports a failed update with the last line the tool printed', async () => {
    updates.claude = { result: { code: 1, output: 'Checking for updates\n\nnpm exited with code 1\n\n' } };
    expect(await updateTool('claude', deps())).toEqual({ id: 'claude', status: 'failed', version: '2.1.330', reason: 'npm exited with code 1' });
  });

  it('names the exit code or the timeout when a failed update printed nothing', async () => {
    updates.claude = { result: { code: 3, output: '' } };
    expect(await updateTool('claude', deps())).toMatchObject({ status: 'failed', reason: 'exit code 3' });
    updates.claude = { result: { code: null, output: '' } };
    expect(await updateTool('claude', deps())).toMatchObject({ status: 'failed', reason: 'timed out or could not start' });
  });

  it('reports a tool that is not installed', async () => {
    delete installed.grok;
    expect(await updateTool('grok', deps())).toEqual({ id: 'grok', status: 'missing' });
  });

  it('drops the cached latest version of the tool it ran, and keeps the others', async () => {
    await inspectTools(deps());
    updates.grok = { result: ok('done'), installs: 'grok 1.0.92' };
    await updateTool('grok', deps());
    expect(Object.keys(await readCache()).sort()).toEqual(['claude', 'codex']);
  });
});
