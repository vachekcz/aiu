#!/usr/bin/env bash
set -euo pipefail

# pr-review-comment.sh — create or rewrite the one "## Review PR" comment on a PR.
#
# The PR review charter keeps a single review comment per PR and rewrites it on
# a later round. Doing that by hand with `gh api` has a trap: `-f body=@file`
# publishes the literal path instead of the file and wipes the previous round.
# This script finds the comment by its first line, posts the file and reads the
# published body back.
#
# Usage:  pr-review-comment.sh [--apply|--dry-run] [--heading TEXT] [--repo OWNER/REPO] [--quiet] <PR> <body-file>
#   --dry-run        (default) only report whether it would create or rewrite a comment
#   --apply          post the body, then read the published comment back
#   --heading TEXT   first line that identifies the comment (default: "## Review PR")
#   --repo O/R       target repository (default: the repository `gh` resolves here)
#   --quiet,-q       suppress progress on stderr
#   <PR>             pull request number
#   <body-file>      Markdown body; its first line must equal the heading
#
# Output (stdout, one TAB-separated line):
#   would-create  <PR>                 no comment with the heading yet
#   would-update  <comment id>         that comment would be rewritten
#   created       <comment id>  <url>  posted and read back
#   updated       <comment id>  <url>  rewritten and read back
#
# Exit: 0 ok, 1 failure (gh error, two comments with the heading, published body
# differs from the file), 2 usage error.
#
# Portability: Bash 3.2+, needs an authenticated `gh`; filters run through `gh --jq`.

usage() { sed -n '/^# Usage:/,/^# Portability/{/^# Portability/d;p;}' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; }

apply=0
heading='## Review PR'
repo=''
quiet=0
pr=''
file=''

note() { [ "$quiet" -eq 1 ] || printf '%s\n' "$*" >&2; }
fail() { printf 'pr-review-comment: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'pr-review-comment: %s\n' "$*" >&2; usage >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --dry-run) apply=0; shift ;;
    --heading)
      [ $# -ge 2 ] || usage_error "--heading potřebuje hodnotu"
      heading="$2"; shift 2 ;;
    --repo)
      [ $# -ge 2 ] || usage_error "--repo potřebuje hodnotu OWNER/REPO"
      repo="$2"; shift 2 ;;
    -q|--quiet) quiet=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage_error "neznámý přepínač $1" ;;
    *)
      if [ -z "$pr" ]; then pr="$1"
      elif [ -z "$file" ]; then file="$1"
      else usage_error "přebytečný argument $1"
      fi
      shift ;;
  esac
done

case "$pr" in
  '' | *[!0-9]*) usage_error "číslo PR chybí nebo není číslo: '$pr'" ;;
esac
[ -n "$file" ] || usage_error "chybí soubor s tělem komentáře"
if [ ! -f "$file" ] || [ ! -s "$file" ]; then
  usage_error "soubor $file neexistuje nebo je prázdný"
fi
[ -n "$heading" ] || usage_error "--heading nesmí být prázdný"

first_line=''
IFS= read -r first_line < "$file" || true
first_line="${first_line%$'\r'}"
[ "$first_line" = "$heading" ] ||
  usage_error "první řádek $file je '$first_line', čekám '$heading' (podle něj se komentář v dalším kole najde)"

command -v gh >/dev/null 2>&1 || fail "gh není k dispozici"

if [ -z "$repo" ]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || fail "nepodařilo se zjistit repozitář; zadej --repo"
fi

pr_state="$(gh pr view "$pr" --repo "$repo" --json state,isDraft --jq '"\(.state) \(.isDraft)"')" ||
  fail "PR #$pr v $repo se nepodařilo načíst"
case "$pr_state" in
  'OPEN true') note "PR #$pr je draft" ;;
  'OPEN false') note "PR #$pr už není draft; charta čeká review na draftu" ;;
  *) note "PR #$pr je ${pr_state% *}; komentář už merge nezastaví" ;;
esac

# Ids of the comments whose first line is the heading. The filter compares the
# heading itself: passing first lines back to the shell as TSV would escape "\"
# and TAB, and a heading containing them would never match.
# shellcheck disable=SC2016 # $ENV.HEADING is jq, not shell
ids="$(HEADING="$heading" gh api --paginate "repos/$repo/issues/$pr/comments" \
  --jq '.[] | select((.body | split("\n")[0] | rtrimstr("\r")) == $ENV.HEADING) | .id')" ||
  fail "komentáře PR #$pr se nepodařilo načíst"

matches=''
count=0
for comment_id in $ids; do
  matches="${matches:+$matches }$comment_id"
  count=$((count + 1))
done

[ "$count" -le 1 ] || fail "PR #$pr má $count komentáře s nadpisem '$heading' ($matches); nech jeden a spusť znovu"

if [ "$apply" -eq 0 ]; then
  if [ "$count" -eq 0 ]; then
    note "dry-run: založil bych nový komentář; zapiš s --apply"
    printf 'would-create\t%s\n' "$pr"
  else
    note "dry-run: přepsal bych komentář $matches; zapiš s --apply"
    printf 'would-update\t%s\n' "$matches"
  fi
  exit 0
fi

# -F reads the file behind @; -f would publish the literal "@path".
if [ "$count" -eq 0 ]; then
  action='created'
  result="$(gh api -X POST "repos/$repo/issues/$pr/comments" -F "body=@$file" --jq '"\(.id)\t\(.html_url)"')" ||
    fail "komentář se nepodařilo založit"
else
  action='updated'
  result="$(gh api -X PATCH "repos/$repo/issues/comments/$matches" -F "body=@$file" --jq '"\(.id)\t\(.html_url)"')" ||
    fail "komentář $matches se nepodařilo přepsat"
fi
tab="$(printf '\t')"
comment_id="${result%%"$tab"*}"
comment_url="${result#*"$tab"}"

published="$(gh api "repos/$repo/issues/comments/$comment_id" --jq .body)" ||
  fail "zveřejněný komentář $comment_id se nepodařilo přečíst zpět"
expected="$(cat "$file")"
if [ "$published" != "$expected" ]; then
  fail "zveřejněné tělo komentáře $comment_id se liší od $file (první řádek: '${published%%$'\n'*}'); oprav ho a spusť znovu"
fi

note "komentář $comment_id: zapsáno a přečteno zpět"
printf '%s\t%s\t%s\n' "$action" "$comment_id" "$comment_url"
