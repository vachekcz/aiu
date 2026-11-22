import { describe, expect, it } from 'vitest';
import { fakeToolDeps, latestVersions, NOT_RUN, ok, type FakeToolState } from './tools.ts';

const state = (overrides: Partial<FakeToolState> = {}): FakeToolState => ({
  dir: '/nowhere',
  now: () => new Date('2026-11-22T12:00:00Z'),
  installed: {},
  registry: {},
  grokCheck: NOT_RUN,
  updates: {},
  commands: [],
  requests: [],
  ...overrides,
});

describe('fakeToolDeps', () => {
  it('throws on a command the tools module is not meant to run', async () => {
    const deps = fakeToolDeps(state({ installed: { claude: '2.1.330' } }));
    await expect(deps.run('claude', ['update', '--check'], 1)).rejects.toThrow('unexpected command: claude update --check');
    await expect(deps.run('codex', ['update', '--check', '--json'], 1)).rejects.toThrow('unexpected command');
  });

  it('throws on a request outside the npm registry', async () => {
    await expect(fakeToolDeps(state()).fetch('https://example.com/latest')).rejects.toThrow('unexpected request');
  });

  it('reports a tool that is not installed as a command that did not run', async () => {
    expect(await fakeToolDeps(state()).run('grok', ['--version'], 1)).toEqual(NOT_RUN);
  });

  it('installs the new version on update and succeeds unless told otherwise', async () => {
    const machine = state({ installed: { claude: '1.0.0' }, updates: { claude: { installs: '1.1.0' }, codex: { result: { code: 1, output: 'boom' } } } });
    const deps = fakeToolDeps(machine);
    expect(await deps.run('claude', ['update'], 5)).toEqual(ok(''));
    expect(await deps.run('claude', ['--version'], 5)).toEqual(ok('1.1.0'));
    expect(await deps.run('codex', ['update'], 5)).toEqual({ code: 1, output: 'boom' });
    expect(machine.commands).toEqual(['claude update @5', 'claude --version @5', 'codex update @5']);
  });

  it('answers 404 for a package the registry does not know', async () => {
    const machine = state(latestVersions({ claude: '2.1.341' }));
    const deps = fakeToolDeps(machine);
    expect(await (await deps.fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest')).json()).toEqual({ version: '2.1.341' });
    expect((await deps.fetch('https://registry.npmjs.org/@openai/codex/latest')).status).toBe(404);
    expect(machine.requests).toHaveLength(2);
  });
});

describe('latestVersions', () => {
  it('maps tools to their registry package and the grok check', () => {
    expect(latestVersions({ claude: '2.1.341', codex: '0.171.0', grok: '1.0.92' })).toEqual({
      registry: { '@anthropic-ai/claude-code': '2.1.341', '@openai/codex': '0.171.0' },
      grokCheck: ok('{"latestVersion":"1.0.92"}'),
    });
    expect(latestVersions({})).toEqual({ registry: {}, grokCheck: NOT_RUN });
  });
});
