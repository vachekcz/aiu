# Tool Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `aiu` ends with a `Tools` section (installed and latest version of `claude`, `codex`, `grok`), and `aiu update [tool...]` runs each tool's own `update`.

**Architecture:** A new `src/tools.ts` owns everything about the tools: the registry, version checks with a 24 h file cache, and running updates. It talks to the outside only through an injected `ToolDeps` (command runner, `fetch`, clock, cache directory). `src/render.ts` draws the section from the plain `ToolStatus`; `src/cli.ts` wires both in.

**Tech Stack:** TypeScript on Node 24.2+, `node:child_process`, global `fetch`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-tool-updates-design.md`

## Global Constraints

- Code, identifiers, comments and CLI output in English.
- Tests never run the real tools and never hit the network: stub the runner and `fetch`.
- The version check never fails or hangs `aiu`: every command and request has a 3 s timeout, every failure degrades to "latest unknown".
- No new dependencies.

## Review Focus

- A tool's `--version` prints no dotted number, or exits non-zero: the tool is treated as not installed.
- The cache file is corrupt or has an unexpected shape: it is ignored and rewritten, never an error.
- The registry answers 200 with a body that has no `version` string: latest unknown, nothing cached.
- The installed version is ahead of the cached latest (the tool updated itself): shown as `✓ latest`.
- `aiu update` when a tool's `update` command exits 0 but prints nothing and changes nothing: `✓ already latest`.

Each line has a test in Task 1 or Task 3.

---

### Task 1: Version checks (`src/tools.ts`)

**Files:** Create `src/tools.ts`, `tests/tools.test.ts`.

**Interfaces (produces):**

```ts
export type ToolId = 'claude' | 'codex' | 'grok';
export const TOOL_IDS: readonly ToolId[];                       // display order: claude, codex, grok
export const resolveToolId = (name: string): ToolId | undefined; // 'chatgpt' -> 'codex'
export interface ToolStatus { id: ToolId; installed: string; latest: string | null; updateAvailable: boolean }
export interface CommandResult { code: number | null; output: string } // code null: could not start or timed out
export interface ToolDeps {
  run: (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
  fetch: typeof fetch;
  now: () => Date;
  cacheDir: () => string;
}
export const defaultToolDeps = (): ToolDeps;                     // execFile, global fetch, configDir()
export const isNewer = (candidate: string, installed: string): boolean;
export async function inspectTools(deps: ToolDeps, options?: { fresh?: boolean; only?: ToolId[] }): Promise<ToolStatus[]>;
```

- Installed: `run(id, ['--version'], 3000)`; first `/\d+(?:\.\d+)+/` match of the output; no match or `code !== 0` means not installed, and the tool is left out.
- Latest: `claude`/`codex` from `GET https://registry.npmjs.org/<package>/latest` (`@anthropic-ai/claude-code`, `@openai/codex`), field `version`, `AbortSignal.timeout(3000)`; `grok` from `run('grok', ['update', '--check', '--json'], 3000)`, field `latestVersion`.
- Cache: `<cacheDir>/tool-versions.json`, `{ [id]: { latest, checkedAt } }`, valid for 24 h, written via temp file + rename like `store/accounts.ts`. `fresh: true` skips reading it but still writes.
- `isNewer` compares dotted numbers left to right, missing parts as 0.

- [ ] Tests first: `isNewer` (`2.1.341` vs `2.1.330`, `1.0.9` vs `1.0.10`, equal, `1.2` vs `1.2.0`); `resolveToolId`; `inspectTools` for: outdated tool, up-to-date tool, missing tool left out, cache hit makes no request, cache older than 24 h refetches, `fresh` refetches, failed request gives `latest: null` and caches nothing, plus the five Review Focus cases that belong here.
- [ ] Run `npx vitest run tests/tools.test.ts`, see them fail; implement; see them pass.
- [ ] Commit: `add tool version checks with a daily cache`.

### Task 2: `Tools` section in the output

**Files:** Modify `src/render.ts`, `src/cli.ts`, `scripts/readme-examples.ts`, `tests/render.test.ts`, `tests/cli.test.ts`, `README.md`; create `docs/examples/tools.svg`.

**Interfaces:**
- Consumes: `ToolStatus`, `ToolDeps`, `inspectTools`, `defaultToolDeps`.
- Produces: `renderTools(tools: ToolStatus[], options: { color: ColorMode }): string` (empty string for no tools); `renderOverview(usages, now, { color, tools? })` appends a blank line and the section; `renderJson(usages, now, tools?)` adds `tools` (always an array); `CliDeps.tools: ToolDeps`.

Exact output, colour `none`:

```
Tools  installed CLI versions · update with: aiu update
    claude   2.1.330  → 2.1.341
    codex    0.171.0  → 0.173.0
    grok     1.0.89   ✓ latest
```

Name and version columns are padded to their longest value plus 3 and 2 spaces. Styles: title bold, subtitle dim, `aiu update` cyan, `→ <latest>` yellow, `✓ latest` green. The `· update with:` part only when a tool is outdated. In `showUsage`, `inspectTools` runs concurrently with `collectUsage`; with no accounts the existing message is followed by a blank line and the section.

- [ ] Tests first: `renderTools` for the block above, all-latest (no hint), latest unknown (version only), empty list; `renderOverview` with and without `tools`; CLI: default output ends with the section, `--json` has `tools`, no accounts still shows it, a throwing `tools.run` does not fail the command.
- [ ] Implement; add a `tools` field to `Example` and a `tools.svg` example to `EXAMPLES`; run `npm run docs:examples`; document the section in `README.md`.
- [ ] `npm test && npm run typecheck`; commit: `show installed and latest tool versions`.

### Task 3: `aiu update`

**Files:** Modify `src/tools.ts`, `src/cli.ts`, `tests/tools.test.ts`, `tests/cli.test.ts`, `README.md`, `AGENTS.md` (project line mentions the new command only if needed).

**Interfaces (produces):**

```ts
export type UpdateOutcome =
  | { id: ToolId; status: 'updated'; from: string; to: string }
  | { id: ToolId; status: 'current'; version: string }
  | { id: ToolId; status: 'failed'; version: string; reason: string }
  | { id: ToolId; status: 'missing' };
export async function updateTool(id: ToolId, deps: ToolDeps): Promise<UpdateOutcome>;
export const UPDATE_TIMEOUT_MS = 300_000;
```

- `updateTool`: fresh `inspectTools` for that tool; not installed gives `missing`; latest known and not newer gives `current` without running anything; otherwise `run(id, ['update'], UPDATE_TIMEOUT_MS)`, then read the version again. Non-zero or `null` code gives `failed` with the last non-empty output line (or `timed out` / `exit code N`); changed version gives `updated`; else `current`. The tool's cache entry is dropped after a run.
- CLI: `aiu update [tool...]`. Unknown name: stderr `Unknown tool: <name>. Use one of: claude, codex, grok`, exit 2, nothing runs. No names: every installed tool, and `missing` ones are not listed; with none installed print `No tools installed.` and exit 0. Duplicates collapse. Lines are printed as each tool finishes:

```
  claude   2.1.330 → 2.1.341   ✓ updated
  codex    0.171.0             ! failed: npm exited with code 1
  grok     1.0.89              ✓ already latest
  grok                         ! not installed
```

  Exit 1 when any outcome is `failed` or `missing`. Other commands keep rejecting extra positionals. `USAGE` gets the new line.

- [ ] Tests first for each outcome, the Review Focus case, the cache drop, and the CLI behaviours above.
- [ ] Implement; document in `README.md`; `npm test && npm run typecheck`; commit: `add aiu update for the CLI tools`.
