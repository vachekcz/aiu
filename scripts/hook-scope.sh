#!/usr/bin/env bash
# Shared helpers for .githooks/pre-push: which files a push changes, whether a
# step is in scope, which steps run only on request, and a cache of trees that
# already passed. Sourced, not executed — it defines functions and variables.
#
#   . "$ROOT/scripts/hook-scope.sh"
#   hook_scope_init "$@"               # consumes git's pre-push stdin
#   [ "$HOOK_PUSH_HAS_CONTENT" = 1 ] || exit 0
#   hook_cache_hit && exit 0           # this tree already passed at this tier
#   if hook_docs_only 'docs/*' '*.md'; then hook_step "Docs" -- npm run check:docs; exit 0; fi
#   hook_step "ESLint" '*.ts' '*.tsx' 'eslint.config.*' -- npm run lint
#   hook_step "Unit testy" -- npm test
#   hook_step --heavy "Integrační testy" 'src/*' 'migrations/*' -- npm run test:integration
#   hook_cache_store                   # after every step passed
#
# The cache only records runs in which every step of the tier ran: a push where
# a pattern skipped a step (or a docs-only exit) is not cached, because what the
# patterns skipped depends on the push's base, not on the tree alone.
#
# hook_step [--heavy] "<label>" [<pattern>...] -- <command...>
#   Runs <command> through scripts/hook-run-step.sh. With patterns it runs only
#   when the push changes a matching file; without patterns it always runs.
#   --heavy steps (the slow suites CI runs anyway) run only with HOOK_FULL=1.
#   The `--` is required, so a pattern can never be mistaken for the command.
#
# Patterns are bash globs matched against repo-relative paths, where `*` also
# spans `/`: 'src/*' is everything under src/, '*.md' is Markdown anywhere.
#
# Scope is FAIL-OPEN: whenever the pushed range cannot be determined (new branch
# without a known default branch, remote commit missing locally, shallow clone),
# every scoped step runs, as if all files changed.
#
# Env switches:
#   HOOK_FULL=1        also run heavy steps (the ones CI runs anyway); default off
#   HOOK_NO_CACHE=1    ignore and do not write the verified-tree cache
#   HOOK_NO_SCOPE=1    run every step regardless of what the push changes
#   HOOK_CACHE_ENV_EXTRA=...  extra toolchain identity for the cache key, set by
#                      the hook, e.g. "$(terraform version | head -1)"
#
# Part of the dev-template `git-hooks/` bundle. Bash 3.2 compatible.

# Variables read by the sourcing hook.
# shellcheck disable=SC2034
HOOK_ZERO_SHA="0000000000000000000000000000000000000000"
# shellcheck disable=SC2034
HOOK_PUSH_HAS_CONTENT=0
HOOK_SCOPE_ALL=0
HOOK_PUSH_TREES=""
HOOK_CHANGED_FILES=""
HOOK_SCOPE_SKIPPED=0

# The remote's default branch as a local ref, e.g. refs/remotes/origin/main.
hook_default_ref() {
  local remote="$1" ref
  ref="$(git symbolic-ref -q "refs/remotes/${remote}/HEAD" 2>/dev/null || true)"
  if [ -n "$ref" ]; then
    printf '%s\n' "$ref"
    return 0
  fi
  for ref in "refs/remotes/${remote}/main" "refs/remotes/${remote}/master"; do
    if git rev-parse -q --verify "${ref}^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "$ref"
      return 0
    fi
  done
  return 1
}

# Reads "<local ref> <local sha> <remote ref> <remote sha>" lines from stdin
# (git's pre-push protocol) and records the pushed trees and the union of files
# the push changes on the remote. Arguments: the hook's "$@" (remote name, url).
hook_scope_init() {
  local remote="${1:-origin}" base default_ref files
  local _local_ref local_sha _remote_ref remote_sha
  [ "${HOOK_NO_SCOPE:-}" = "1" ] && HOOK_SCOPE_ALL=1
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    [ "$local_sha" = "$HOOK_ZERO_SHA" ] && continue
    # shellcheck disable=SC2034 # read by the sourcing hook
    HOOK_PUSH_HAS_CONTENT=1
    HOOK_PUSH_TREES="${HOOK_PUSH_TREES}$(git rev-parse "${local_sha}^{tree}")
"
    [ "$HOOK_SCOPE_ALL" = "1" ] && continue
    base=""
    if [ "$remote_sha" != "$HOOK_ZERO_SHA" ]; then
      # Updating a branch: compare against what the remote has now. A tree diff
      # (not a log range) is right for force-pushes too.
      if git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
        base="$remote_sha"
      fi
    elif default_ref="$(hook_default_ref "$remote")"; then
      # New branch: compare against where it forked from the default branch.
      base="$(git merge-base "$default_ref" "$local_sha" 2>/dev/null || true)"
    fi
    if [ -z "$base" ]; then
      HOOK_SCOPE_ALL=1
      continue
    fi
    # quotePath=false keeps non-ASCII paths raw so patterns can match them; git
    # still C-quotes paths with quotes, backslashes or control characters, and
    # those make the scope unknown rather than silently unmatched.
    if ! files="$(git -c core.quotePath=false diff --name-only --no-renames "$base" "$local_sha" 2>/dev/null)"; then
      HOOK_SCOPE_ALL=1
      continue
    fi
    case "$files" in
      \"*|*"
\""*)
        HOOK_SCOPE_ALL=1
        continue
        ;;
    esac
    [ -n "$files" ] && HOOK_CHANGED_FILES="${HOOK_CHANGED_FILES}${files}
"
  done
  return 0
}

# True when any changed file matches any pattern (or scope is unknown).
hook_changed() {
  local path pattern
  [ "$HOOK_SCOPE_ALL" = "1" ] && return 0
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    for pattern in "$@"; do
      # shellcheck disable=SC2053 # the pattern is intentionally a glob
      [[ "$path" == $pattern ]] && return 0
    done
  done <<EOF
$HOOK_CHANGED_FILES
EOF
  return 1
}

# True when some changed file matches NONE of the patterns — e.g.
# `hook_changed_except 'docs/*' '*.md'` means "the push touches code".
hook_changed_except() {
  local path pattern matched
  [ "$HOOK_SCOPE_ALL" = "1" ] && return 0
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    matched=0
    for pattern in "$@"; do
      # shellcheck disable=SC2053 # the pattern is intentionally a glob
      if [[ "$path" == $pattern ]]; then
        matched=1
        break
      fi
    done
    [ "$matched" = "0" ] && return 0
  done <<EOF
$HOOK_CHANGED_FILES
EOF
  return 1
}

# True when the push changes only files matching the patterns (docs, meta),
# i.e. no code. Marks the run as partial, so the tree is not cached as verified.
# Usage: if hook_docs_only 'docs/*' '*.md'; then <docs checks>; exit 0; fi
hook_docs_only() {
  hook_changed_except "$@" && return 1
  HOOK_SCOPE_SKIPPED=1
  return 0
}

# See the header for usage.
hook_step() {
  local heavy=0 label
  if [ "${1:-}" = "--heavy" ]; then
    heavy=1
    shift
  fi
  label="${1:?hook_step: missing label}"
  shift
  local patterns=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    patterns+=("$1")
    shift
  done
  if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
    echo "hook_step: expected '-- <command>' after the label and patterns (${label})" >&2
    return 2
  fi
  shift
  if [ "$heavy" = "1" ] && [ "${HOOK_FULL:-}" != "1" ]; then
    echo "↷ ${label} — jen v CI (lokálně: HOOK_FULL=1 git push)"
    return 0
  fi
  if [ "${#patterns[@]}" -gt 0 ] && ! hook_changed "${patterns[@]}"; then
    echo "↷ ${label} — push nemění soubory, které kontroluje"
    HOOK_SCOPE_SKIPPED=1
    return 0
  fi
  bash "$(git rev-parse --show-toplevel)/scripts/hook-run-step.sh" "$label" "$@"
}

hook_cache_tier() {
  if [ "${HOOK_FULL:-}" = "1" ]; then echo full; else echo fast; fi
}

# The runtime a result depends on beyond the tree itself. The tree already
# covers the hooks, lockfiles and version files; this adds what is installed.
# Hooks for other toolchains add their versions via HOOK_CACHE_ENV_EXTRA.
hook_cache_env() {
  { uname -sm; command -v node >/dev/null 2>&1 && node --version
    printf '%s\n' "${HOOK_CACHE_ENV_EXTRA:-}"; } \
    | git hash-object --stdin
}

# True when the checks would not see exactly what is pushed: a pushed tree is
# not HEAD's, or the worktree has uncommitted or untracked changes (optionally
# only under the given pathspecs). Steps read the working tree, so the hook can
# warn, or stop the push where that matters.
# shellcheck disable=SC2120 # pathspecs are optional; hooks pass them
hook_worktree_differs() {
  local head_tree tree
  head_tree="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" || return 0
  while IFS= read -r tree; do
    [ -n "$tree" ] || continue
    [ "$tree" = "$head_tree" ] || return 0
  done <<EOF
$HOOK_PUSH_TREES
EOF
  [ -n "$(git status --porcelain --untracked-files=normal -- "$@" 2>/dev/null)" ]
}

hook_cache_dir() {
  printf '%s/hook-verified\n' "$(git rev-parse --git-common-dir)"
}

# True when every pushed tree already passed at this tier (a full pass also
# counts for the fast tier). Shared across worktrees of the same repository.
hook_cache_hit() {
  local dir env tier tree
  [ "${HOOK_NO_CACHE:-}" = "1" ] && return 1
  [ -n "$HOOK_PUSH_TREES" ] || return 1
  dir="$(hook_cache_dir)"
  env="$(hook_cache_env)"
  tier="$(hook_cache_tier)"
  while IFS= read -r tree; do
    [ -n "$tree" ] || continue
    [ -e "$dir/${tree}-${env}-full" ] && continue
    [ "$tier" = "fast" ] && [ -e "$dir/${tree}-${env}-fast" ] && continue
    return 1
  done <<EOF
$HOOK_PUSH_TREES
EOF
  echo "✓ Tenhle strom už kontrolami prošel (${tier}) — pouštím push bez nich."
  return 0
}

# Records that the checks passed. The checks ran on the working tree, so the
# result only belongs to a tree when the worktree is clean and HEAD is exactly
# what is being pushed, and only when no step was skipped by its patterns;
# otherwise nothing is cached.
hook_cache_store() {
  local dir env tier head_tree tree
  [ "${HOOK_NO_CACHE:-}" = "1" ] && return 0
  [ "$HOOK_SCOPE_SKIPPED" = "0" ] || return 0
  [ -n "$HOOK_PUSH_TREES" ] || return 0
  # shellcheck disable=SC2119 # the whole worktree must be clean here
  hook_worktree_differs && return 0
  head_tree="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" || return 0
  dir="$(hook_cache_dir)"
  env="$(hook_cache_env)"
  tier="$(hook_cache_tier)"
  mkdir -p "$dir" 2>/dev/null || return 0
  : >"$dir/${head_tree}-${env}-${tier}" 2>/dev/null || return 0
  # Keep the cache small: the newest 200 entries are plenty.
  # shellcheck disable=SC2012 # names are hex hashes, ls is safe here
  { ls -t "$dir" 2>/dev/null | tail -n +201 | while IFS= read -r old; do
    rm -f "$dir/$old"
  done; } || true
  return 0
}
