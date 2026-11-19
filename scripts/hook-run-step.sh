#!/usr/bin/env bash
set -u

# Runs one named git-hook step quietly: hides its output behind a per-step log
# file and only prints a short success line. On failure it shows the exit code,
# the log path and the last N lines so you can diagnose without re-running.
# If the log file cannot be created, the step streams live instead — a failed
# redirect must never masquerade as a step failure.
#
# Env switches:
#   HOOK_VERBOSE=1     stream the command's output live instead of logging it
#   HOOK_LOG_FILE=...  create this explicit log file (must not already exist)
#   HOOK_LOG_DIR=...   parent for a private log directory (default: $TMPDIR or /tmp)
#   HOOK_TAIL_LINES=N  how many trailing log lines to show on failure (default 80)
#
# Usage: hook-run-step.sh <label> <command> [args...]

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <label> <command> [args...]" >&2
  exit 2
fi

LABEL="$1"
shift

if [ "${HOOK_VERBOSE:-}" = "1" ]; then
  echo "▶ ${LABEL}…"
  "$@"
  exit $?
fi

LOG_FILE="${HOOK_LOG_FILE:-}"
ORIGINAL_UMASK="$(umask)"
umask 077
LOG_READY=0
if [ -z "$LOG_FILE" ]; then
  REPO_NAME="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
  LOG_PARENT="${HOOK_LOG_DIR:-${TMPDIR:-/tmp}}"
  LABEL_SLUG="$(printf '%s' "$LABEL" | tr -cs '[:alnum:]' '-' | sed 's/^-*//;s/-*$//')"
  if mkdir -p "$LOG_PARENT" 2>/dev/null &&
    LOG_DIR="$(mktemp -d "$LOG_PARENT/${REPO_NAME}-hooks.XXXXXX" 2>/dev/null)"; then
    LOG_FILE="$LOG_DIR/${LABEL_SLUG:-step}.log"
    LOG_READY=1
  else
    LOG_FILE="$LOG_PARENT/${REPO_NAME}-hooks.XXXXXX/${LABEL_SLUG:-step}.log"
  fi
elif mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null; then
  LOG_READY=1
fi

# Open the writer only once. Noclobber refuses existing files atomically; the
# explicit checks also reject symlinks and special files before opening them.
if [ "$LOG_READY" = 1 ] && [ ! -e "$LOG_FILE" ] && [ ! -L "$LOG_FILE" ] &&
  { set -C; exec 3>"$LOG_FILE"; } 2>/dev/null; then
  LOG_READY=1
else
  LOG_READY=0
fi
set +C
umask "$ORIGINAL_UMASK"

if [ "$LOG_READY" != 1 ]; then
  echo "⚠ ${LABEL}: nelze zapsat log (${LOG_FILE}) — streamuju výstup naživo." >&2
  echo "▶ ${LABEL}…"
  "$@"
  exit $?
fi

echo "▶ ${LABEL}…"
if "$@" >&3 2>&1; then
  exec 3>&-
  echo "✓ ${LABEL}"
  exit 0
else
  STATUS=$?
fi
exec 3>&-

TAIL_LINES="${HOOK_TAIL_LINES:-80}"

echo "❌ ${LABEL} selhalo (exit ${STATUS})."
echo "   Log: ${LOG_FILE}"
echo ""
echo "── posledních ${TAIL_LINES} řádků ──"
tail -n "$TAIL_LINES" "$LOG_FILE" || true

exit "$STATUS"
