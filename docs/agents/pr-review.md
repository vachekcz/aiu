# PR review

The last step before a PR is handed over: a pragmatic review run in a fresh
context. The author's agent fixes the findings on the branch, posts the result
as one PR comment and only then marks the PR ready for review. Written for any
agent that can read this repo and run `gh`.

Source: bundle `pr-review` from dev-template, version 2026-11-09.

## Profile

This review covers code and prose, because no code reviewer runs reliably on
this repo: it is new (first PR 2026-11-18) and has no Greptile config. The
cubic AI reviewer may comment on a PR; its threads are answered and resolved
as usual, and the review does not wait for it.

## When

- The work is done, the PR is open as a **draft** (`gh pr create --draft`) and
  the checks pass on its head: the `CI Passed` check of
  `.github/workflows/ci.yml` (typecheck, and `npm test` on macOS), which runs
  on draft PRs too. Fix failures first. A draft cannot be merged, so nobody
  merges the PR before its findings are in. A PR that is already ready goes
  back with `gh pr ready --undo N` for the review.
- Skip it only when the diff has nothing in [Scope](#scope), or is a
  dependency bump that changes only `package.json` and `package-lock.json`.
  Write `Review PR: přeskočeno, <důvod>` in the PR body and mark the PR ready.

## Scope

Everything the diff touches that falls under this list, plus what those
changes claim:

- code and tests: `src/`, `tests/`, `scripts/`, `package.json`,
  `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`,
  `.nvmrc`, `.github/`, `.githooks/`, `.claude/settings.json`
- prose: `docs/**`, `AGENTS.md`, `README.md`
- user-visible text: CLI output and error messages in `src/cli.ts` and
  `src/render.ts`
- the PR title and body, and the linked issue's „Hotovo, když" when there is one

Exclusions: `docs/superpowers/**` (design specs and implementation plans) is a
point-in-time record of how the work was planned. Read it to learn what the PR
was meant to do; do not review its prose, and do not flag it for being out of
date. `.superpowers/` is ignored by Git and never part of a PR.

Stale code or text the diff does not touch is out of scope; mention at most
one as P3.

## Loop

1. **Round 1.** Start the reviewer in a fresh context seeded only with the PR
   number and this file: „Proveď review PR #N podle docs/agents/pr-review.md.
   Vrať jen review, nic neměň." A fresh context is a new agent or session that
   has not seen the implementation, whatever the tool calls it; never a copy
   of the author's context. Never hand it the implementation transcript: a
   reviewer that has seen the reasoning re-derives it instead of testing it.
   The reviewer returns the comment body: findings in section 2 without a
   status, each with P1–P3, `file:line` and a concrete change; its verdict in
   section 4; in section 5 only its score for the reviewed head. The author's
   agent adds the statuses, `zapracováno v` and the score after fixes.
2. **Check the evidence** ([Reviewer evidence](#reviewer-evidence)) before
   acting on the review. A review that fails the check is a failed round, not
   a clean one: run it again.
3. **Fix.** The author's agent fixes every finding in section 2, P1, P2 and P3
   alike, in one commit `Apply PR review findings`, pushes it and runs the
   checks again. A finding is rejected only when it is wrong: ❌ with a
   one-line reason. A fix that needs a product decision stays ⚠️ open with one
   question for the user, never an improvised answer. Overengineering items
   are suggestions.
4. **Round 2** runs when round 1 had a P1 or when the fixes changed code
   rather than only prose. Seed it with the step-1 seed, the round-1 SHA, the
   round-1 findings with the author's statuses and reasons, and the pushed
   head, nothing else.
   Round 2 reviews only the fixes,
   `git log -p --first-parent --remerge-diff <round-1 sha>..<new head>`:
   commits brought in by merging the base branch stay out and such a merge
   shows only its conflict resolutions. It confirms each fix, reports what
   the fixes broke, and withdraws or keeps each rejected P1. The author does
   not get the last word on a P1: one the reviewer keeps becomes ⚠️ with a
   question for the user. Round-2 findings are fixed as in step 3. Stop after
   two rounds; whatever is still open stays ⚠️.
5. **Post** the comment ([Comment](#comment)) once the last fixes are pushed
   and the checks pass; after round 2 rewrite it instead of adding one. Post
   it before the hand-over, so the PR body can point at it.
6. **Hand over** with `gh pr ready N`. That flip, not opening the PR, is the
   handover. While a P1 is still ⚠️ the PR stays a draft; the comment ends
   with the question for the user. Mark it ready once the answer is in and
   the fix has landed, or when the user decides to ship it as it is.

**Merged before the hand-over.** If the PR is merged before step 6, the loop
moves to a follow-up PR:

- Compare the merged head (`gh pr view N --json headRefOid`) with the round-1
  SHA. Commits after it were never reviewed, so round 2 runs even without a
  P1 or a code fix and covers them too:
  `git log -p --first-parent --remerge-diff <round-1 sha>..<merged head>`.
- Fix the findings in a draft follow-up PR from the default branch that links
  the merged one. Round 2 reviews the fixes as
  `git log -p --first-parent --remerge-diff <merge commit>..<new head>`, so the
  merged change does not come back as a whole.
- The round-1 comment goes on the merged PR, with the statuses and
  `zapracováno v` naming the follow-up. Round 2 posts its own comment on the
  follow-up, linking the first. Hand over the follow-up as in step 6.
- With nothing to fix, no follow-up opens: the comment stays on the merged PR,
  and so does round 2 when the merged head differs from the round-1 SHA.

## Reviewer evidence

The reviewer's reply opens with two things the author's agent checks before
fixing anything:

- `Revidováno nad <sha>`: the PR head it reviewed, from
  `gh pr view N --json headRefOid`. When the local checkout is elsewhere, the
  reviewer reads files with `git show <sha>:<path>` and never reviews
  uncommitted changes.
- **Jak ověřeno:** each command it ran with the line of output its result
  rests on, then what it could not verify and why. Reading files is not a
  check. Commands that read the working tree (`npm test`, `npm run typecheck`)
  count only when `git rev-parse HEAD` equals the SHA and
  `git status --porcelain` is empty; otherwise they go under Neověřeno.
  `gh` and `git` commands that name the SHA count regardless.

The SHA must be the head the author pushed for this round. A review without
both, or over another SHA, proves nothing, however clean it reads.

## What to check

The lenses are correctness, consistency with the repo's rules, practicality
and unnecessary complexity. The rules below summarise [AGENTS.md](../../AGENTS.md)
and the design spec it points to; where they differ, those win.

**Code works.** Name a concrete input or state and the wrong result, with
`file:line`. Look for regressions in behaviour the diff changes indirectly,
not only in the lines it adds. Provider responses come from unofficial
endpoints: check what happens with a missing field, an unknown limit kind, a
timeout or an HTTP error.

**Code checklist.** The repo has no `.greptile/config.json`; the repo rules
below are the whole checklist.

**Tests prove the change.** Every provider parser has a vitest test against a
sanitised fixture in `tests/fixtures/`, including a missing-fields case. A
change to the table or JSON output updates `tests/render.test.ts`. No test
hits a real endpoint: provider tests stub `fetch` with `stubFetch` from
`tests/helpers/fetch.ts`. Only
`tests/store/keychain.test.ts` touches the real Keychain, under the separate
service `ai-usage-test`, and cleans up after itself.

**Repo rules hold.** See [AGENTS.md](../../AGENTS.md#rules):

- Secrets live only in macOS Keychain (service `ai-usage`); never in plain
  files, logs, error messages or process arguments. Writes go through
  `security -i` fed on stdin.
- The app never uses or refreshes tokens owned by Claude Code or Codex: each
  account has its own login, so `aiu` never logs those tools out.
- Rotated tokens are written back to Keychain before the response is used.
- One failing account renders as an error row; it never fails or hangs the
  whole command (each fetch has a timeout).
- The renderer knows only the normalised `Limit` from `src/types.ts`, never
  a provider's response shape.
- Code, identifiers, comments and CLI output are in English.

**Scope is met.** Every item in the linked issue's „Hotovo, když" is done, or
the PR body says why not. Without an issue, the PR body states the goal and
the review checks it against that. A missing criterion is a P1.

**Claims hold.** A claim the diff adds about behaviour matches the code; cite
`file:line`. A number repeated across the PR body, docs and CLI output is the
same everywhere. A command the diff documents (README, AGENTS.md) runs as
written, or the review says why it could not run it. Links resolve; check
anchors by hand.

**Docs stay living.** One fact lives in one place: README is for users,
AGENTS.md for agents, and neither copies the other. A doc that already broke
a rule before this diff gets a follow-up issue, not a fix in this PR.

**PR body.** It says what changed and why, and links the issue when there is
one. Its verification lists only checks that actually ran. Passing tests or a
dry run are not presented as verified behaviour against real accounts. It
never claims a merge or a deploy, and it names the limits.

**Do not** hunt for problems, restate the code or the document, give generic
advice, or nitpick style that `tsc` already enforces.

## Severity

- **P1**: a bug or regression, an unmet goal of the PR, a wrong or
  misleading claim, a secret that can leak, or a gap that blocks real use.
- **P2**: a clear improvement.
- **P3**: nice to have.

All three are fixed before handover. The level orders the work, decides
whether a second round runs and anchors the score. A finding about a state
the diff did not cause (the out-of-scope P3) is closed with a linked
follow-up issue instead, marked ✅ with the issue link.

**Score.** The reviewer scores the head it reviewed: 9–10 ship as-is, 7–8
solid with some P2, 5–6 P1 gaps, ≤4 rework. The heading of section 5 shows
the score after fixes instead, set by the author's agent on the same scale
from what is still open: 10 when the last round found nothing, 9 when every
finding is fixed, moved to a follow-up issue or rejected (❌), 7–8 with an
open P2 or P3, 5–6 with an open P1. A rejected P1 counts as closed only after
the reviewer withdrew it in round 2. The reviewer's score for each round goes
below it.

## Comment

One comment per PR, first line `## Review PR`. Write the body to a file
outside the repo, so the tree stays clean for the next round, and post it
with `scripts/pr-review-comment.sh`; a later round rewrites the same comment
instead of adding one:

```sh
bash scripts/pr-review-comment.sh N /tmp/review-N.md          # preview: new comment, or which one it rewrites
bash scripts/pr-review-comment.sh --apply N /tmp/review-N.md  # post, then read the published body back
```

The script refuses a body whose first line is not the heading, stops when the
PR already has two such comments, and fails when the published body differs
from the file. On round 2, section 2 keeps the round-1 items under their own
subheading below the new ones.

```md
## Review PR

Revidováno nad `<sha>`, zapracováno v `<sha>`. Rozsah: <kód, dokumenty, texty>.

**Jak ověřeno:**

- `<příkaz>`: <řádek výsledku>
- Neověřeno: <co a proč>

### 1. Co je dobré

- <co opravdu funguje, 2–4 body>

### 2. Doporučená zlepšení

✅ zapracováno · ❌ nezapracováno, nález neplatí · ⚠️ zůstává otevřené

- ✅ **P1** `<soubor:řádek>` — <změna> (`<sha>`)
- ❌ **P2** `<místo>` — <změna>. Nález neplatí: <důvod>
- ❌ **P1** `<místo>` — <změna>. Nález neplatí: <důvod>; recenzent ho v kole 2 stáhl
- ⚠️ **P2** `<místo>` — <změna>. Otevřené: <proč, případně otázka>
- (nic: „Žádná.")

### 3. Potenciální overengineering

- <co vyškrtnout, nebo „Nic.">

### 4. Verdikt po zapracování

Ano | Ano po zapracování P1 | Ne — <jedna věta proč>

### 5. Skóre kvality: X/10

Po zapracování: <co zůstává otevřené, nebo „nic nezůstalo otevřené">.

Původní skóre recenzenta:

- kolo 1 nad `<sha>`: X/10
- kolo 2 nad `<sha>`: X/10 <jen když kolo 2 proběhlo>

<jedna otázka pro uživatele, jen když na ni PR čeká>
```
