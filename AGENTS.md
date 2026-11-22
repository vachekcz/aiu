# AGENTS.md

Instructions for coding agents working in this repo. User-facing docs live in
[README.md](./README.md); the original design is in
[docs/superpowers/specs/2026-11-18-ai-usage-cli-design.md](./docs/superpowers/specs/2026-11-18-ai-usage-cli-design.md).

## Project

`aiu` is a macOS CLI (TypeScript, Node 24.2+, run directly from `src/cli.ts`)
that shows the usage limits of Claude, ChatGPT/Codex and Grok subscriptions. Each
provider in `src/providers/` turns its unofficial usage endpoint into the
normalised `Limit` from `src/types.ts`; `src/render.ts` prints a table or JSON.
`src/tools.ts` checks the versions of the `claude`, `codex` and `grok` CLIs and runs their own
`update` for `aiu update`.

## Commands

```bash
npm ci              # install; also wires the Git hooks in .githooks/ (postinstall)
npm test            # vitest; also touches the real Keychain under service ai-usage-test
npm run typecheck   # tsc --noEmit
npm run hooks:doctor  # check that .githooks/ is wired in this worktree
npm run docs:examples  # redraw the README output images after changing the output
```

CI (`.github/workflows/ci.yml`) runs the typecheck on Linux and `npm test` on
macOS; branch protection on `main` requires its single `CI Passed` check. The
pre-push hook (`.githooks/pre-push`) is a fast subset of CI: keep every step
of the hook in CI too, and the docs-only patterns of both in line.

## Rules

- Secrets live only in macOS Keychain (service `ai-usage`), never in plain
  files, logs, error messages or process arguments. Writes go through
  `security -i` fed on stdin.
- Never use or refresh tokens owned by Claude Code or Codex. Each account has
  its own login, so `aiu` never logs those tools out.
- Write rotated tokens back to Keychain before using the response.
- One failing account renders as an error row; it never fails or hangs the
  whole command.
- The renderer knows only the normalised `Limit`, never a provider's response
  shape. Parsers tolerate unknown and missing fields.
- Tests never hit real endpoints; stub `fetch`.
- Code, identifiers, comments, CLI output and commit messages are in English.
  PR title, body and review comments are in Czech.
- Exception: `scripts/pr-review-comment.sh` (bundle `pr-review`) and
  `scripts/hook-run-step.sh`, `hook-scope.sh`, `setup-hooks.sh`,
  `check-hooks.sh`, `ensure-hooks.sh` (bundle `git-hooks`) are 1:1 copies from
  dev-template and keep their Czech messages, so they can be updated by
  copying the new version. Don't edit them here.

## Git workflow

- Never commit directly to `main`; work goes on a branch and through a PR.
  Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`.
- Commits are atomic (one logical change), in English, imperative mood
  (`add`, `fix`, `drop`, not `added` or `adding`).
- Never resolve a review comment silently. When you fix or reject one, reply
  in its thread with what changed and in which commit (or why it won't be
  fixed), then mark the thread resolved.

## Finishing

1. Run `npm test` and `npm run typecheck` on the final head.
2. **Done = an open non-draft PR** after implementation, verification and
   review; a draft still in progress is not done. Open the PR as a draft
   (`gh pr create --draft`). Once the checks pass, run the
   [PR review](./docs/agents/pr-review.md): a reviewer in a fresh context goes
   through the change, you fix the findings on the same branch and post the
   result as one PR comment. Only then `gh pr ready`; that hands the PR over.
   While a P1 stays open, the PR stays a draft.
3. Agent instructions (`docs/agents/`) are in English; the review comment
   they produce is in Czech.
