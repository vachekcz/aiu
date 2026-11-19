#!/usr/bin/env bash
set -euo pipefail

# Points git at the versioned .githooks/ directory for THIS worktree.
# Worktree-scoped so each git worktree can keep its own hooks config.
# Client hooks run from the worktree root, so a relative path survives moves.
# Wire up as an npm script (e.g. "hooks:install") and call it from postinstall so
# a fresh clone is protected automatically. This script self-skips where hooks
# make no sense (CI, or no .git checkout — Docker build, npm pack), but it cannot
# self-skip when it is absent: the usual Docker layer-caching pattern copies only
# package.json + lockfile before `npm ci`, so guard the postinstall on the file
# being there. See package.json.snippet.md. Without a root package.json, run it
# once per worktree by hand (or from a Makefile target), or let an agent's
# session-start hook call scripts/ensure-hooks.sh, which runs it when needed.

case "${CI:-}" in
  "" | false | 0) ;;
  *)
    echo "Detekováno CI — instalace Git hooků přeskočena."
    exit 0
    ;;
esac

if ! ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "Mimo Git checkout — instalace Git hooků přeskočena."
  exit 0
fi

HOOKS_DIR="$ROOT/.githooks"

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo "Chybí adresář s hooky: $HOOKS_DIR" >&2
  exit 1
fi

# A bare repository with linked worktrees (`git clone --bare` + `git worktree add`)
# keeps core.bare=true in the shared config. Once worktree config is enabled every
# worktree reads it and stops being a work tree, so first move it into the bare
# repository's own config.worktree, as Git's init_worktree_config does.
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir)
if [[ "$(git config --file "$COMMON_DIR/config" --get core.bare || true)" == "true" ]]; then
  git config --file "$COMMON_DIR/config.worktree" core.bare true
  git config --file "$COMMON_DIR/config" --unset core.bare
fi

git config extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks

# Hook files have no extension; skip docs and editor droppings.
for hook in "$HOOKS_DIR"/*; do
  [[ -f "$hook" ]] || continue
  case "$(basename "$hook")" in *.*) continue ;; esac
  chmod +x "$hook"
done

echo "Git hooky nastaveny pro tento worktree:"
echo "  core.hooksPath=.githooks"
