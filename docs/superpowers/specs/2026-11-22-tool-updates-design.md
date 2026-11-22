# Tool updates: design

Date: 2026-11-22. Size: a small change. Approved by Pavel in the conversation, including the coloured mock-up.

## Intent

Pavel runs `aiu` many times a day. He wants the same glance to tell him whether the CLI tools behind his
subscriptions (`claude`, `codex`, `grok`) have a newer version, and one command to update them.

## Goals

- `aiu` ends with a `Tools` section: installed version of each tool and, when there is one, the newer version.
- `aiu update [tool...]` updates the named tools, or all of them, by running each tool's own `update` command.

Non-goals: updating `aiu` itself; installing a tool that is missing; choosing release channels.

Anti-goals: the version check must never slow `aiu` down noticeably, fail it, or hang it.

## Approaches

1. **A line under the table, only when something is outdated.** Smallest, but hides the installed versions.
2. **A separate `Tools` section, always shown.** Picked by Pavel: the state is visible at a glance.
3. **Version next to the provider name in the `Accounts` header.** Mixes accounts with tools, and a tool
   without a logged-in account has nowhere to go.

For updating, a subcommand (`aiu update`) rather than a flag, like `login`, `accounts` and `remove`.

## Output

```
Tools  installed CLI versions · update with: aiu update
    claude   2.1.330  → 2.1.341
    codex    0.171.0  → 0.173.0
    grok     1.0.89   ✓ latest
```

- Heading like the other sections (bold title, dim subtitle). The `· update with: aiu update` part, with the
  command in cyan, appears only when at least one tool is outdated.
- Outdated: `→ <latest>` in yellow. Up to date: `✓ latest` in green. Latest unknown: the installed version only.
- A tool that is not installed is left out; with no tool installed the section is left out.
- The section is also printed, on its own, when no account is configured yet.
- `aiu --json` gets `tools: [{ id, installed, latest, updateAvailable }]` (`latest` is `null` when unknown).

## `aiu update`

```
aiu update              # every installed tool
aiu update claude       # one tool
aiu update codex grok   # several
```

- Tool names are `claude`, `codex`, `grok`; `chatgpt` is accepted as an alias of `codex`. An unknown name is a
  usage error (exit 2) before anything runs.
- Tools run one after another. Each gets a fresh version check (the cache is ignored). A tool known to be up to
  date is not run. Otherwise `<tool> update` runs with its output captured.
- Result per tool, printed as it finishes: `✓ updated` (the installed version changed), `✓ already latest`
  (exit 0, version unchanged), `! failed: <last output line>` (non-zero exit, timeout), `! not installed`
  (only for a tool named explicitly).
- One failure does not stop the others; the exit code is 1 when any tool failed.
- The cached latest version of every tool that was run is dropped.

## Where the versions come from

- Installed: `<tool> --version`, first dotted number in the output. Always read fresh.
- Latest: `claude` and `codex` from the npm registry (`@anthropic-ai/claude-code`, `@openai/codex`, the
  `latest` tag); `grok` from `grok update --check --json` (`latestVersion`). Verified on 2026-11-22: the npm
  version of both packages equals the installed native/npm builds.
- Latest versions are cached for 24 hours in `tool-versions.json` in the config directory (not a secret).
  A failed check is not cached and shows the tool without a latest version.
- The checks run in parallel with collecting usage, each with a 3 s timeout.
- A version is newer when its dotted numbers compare greater; an installed version ahead of the cached latest
  counts as up to date.

## Left to the builder

Module layout, exact column widths, test structure. Tests stub the command runner and `fetch`; they never run
the real tools or hit the registry.
