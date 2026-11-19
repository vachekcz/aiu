#!/usr/bin/env bash
set -uo pipefail

# Wires this worktree's git hooks when they are not wired yet, and stays quiet.
# Meant for an agent's session-start hook (Claude Code: SessionStart in
# .claude/settings.json), so a worktree created by a tool (Orca, superset,
# `git worktree add`) gets its hooks without anyone remembering setup-hooks.sh.
# Anyone else still runs setup-hooks.sh once per worktree.
#
# Acts on the worktree of the current directory, using the sibling scripts:
#   - outside a Git checkout, or without .githooks/: nothing to do
#   - check-hooks.sh passes: already wired, nothing to do
#   - otherwise setup-hooks.sh (which itself skips in CI)
# Prints nothing unless setup fails: a session-start hook's stdout lands in
# the agent's context, so the one line it prints tells the agent what to run.
# Always exits 0; a session must not fail because of hooks.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[[ -d "$ROOT/.githooks" ]] || exit 0

bash "$HERE/check-hooks.sh" >/dev/null 2>&1 && exit 0

if ! bash "$HERE/setup-hooks.sh" >/dev/null 2>&1; then
  echo "Git hooky v tomto worktree nejsou zapojené. Spusť: bash scripts/setup-hooks.sh"
fi
exit 0
