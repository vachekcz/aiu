import type { CommandResult, ToolDeps } from '../../src/tools.ts';

const REGISTRY_URL = 'https://registry.npmjs.org/';
const NPM_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' } as const;

export const ok = (output: string): CommandResult => ({ code: 0, output });
/** The result of a command that could not start or timed out. */
export const NOT_RUN: CommandResult = { code: null, output: '' };

/** The machine the fake ToolDeps pretends to run on. Tests keep the objects and change them between calls. */
export interface FakeToolState {
  dir: string;
  now: () => Date;
  /** What `<tool> --version` prints; a missing key means the tool is not installed. */
  installed: Record<string, string>;
  /** The registry's answer per npm package: a version, a whole body, or an Error that fails the request. Missing means 404. */
  registry: Record<string, string | Error | object>;
  /** What `grok update --check --json` answers. */
  grokCheck: CommandResult;
  /** What `<tool> update` does: its result (success without output by default) and the version installed afterwards. */
  updates: Record<string, { result?: CommandResult; installs?: string }>;
  /** Every command that ran, as `<command> <args> @<timeoutMs>`. */
  commands: string[];
  /** Every URL that was fetched. */
  requests: string[];
}

/** Registry and `grok update --check` answers for the given latest versions; a tool left out has no known latest. */
export function latestVersions(latest: { claude?: string; codex?: string; grok?: string }): Pick<FakeToolState, 'registry' | 'grokCheck'> {
  const registry = Object.fromEntries(
    (['claude', 'codex'] as const).flatMap((tool) => (latest[tool] ? [[NPM_PACKAGES[tool], latest[tool]]] : [])),
  );
  return { registry, grokCheck: latest.grok ? ok(JSON.stringify({ latestVersion: latest.grok })) : NOT_RUN };
}

/**
 * ToolDeps over a fake machine. It answers exactly the commands src/tools.ts is meant to run and
 * throws on anything else, so a changed or mistyped command fails the test instead of passing quietly.
 */
export function fakeToolDeps(state: FakeToolState): ToolDeps {
  return {
    run: async (command, args, timeoutMs) => {
      const line = args.join(' ');
      state.commands.push(`${command} ${line} @${timeoutMs}`);
      if (line === '--version') return command in state.installed ? ok(state.installed[command]!) : NOT_RUN;
      if (command === 'grok' && line === 'update --check --json') return state.grokCheck;
      if (line === 'update') {
        const update = state.updates[command] ?? {};
        if (update.installs) state.installed[command] = update.installs;
        return update.result ?? ok('');
      }
      throw new Error(`unexpected command: ${command} ${line}`);
    },
    fetch: (async (url: string) => {
      state.requests.push(url);
      if (!url.startsWith(REGISTRY_URL) || !url.endsWith('/latest')) throw new Error(`unexpected request: ${url}`);
      const answer = state.registry[url.slice(REGISTRY_URL.length, -'/latest'.length)];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) return new Response('not found', { status: 404 });
      return Response.json(typeof answer === 'string' ? { version: answer } : answer);
    }) as typeof fetch,
    now: state.now,
    cacheDir: () => state.dir,
  };
}
