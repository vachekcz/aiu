# aiu — AI subscription usage

Shows the current usage limits of your AI subscriptions (Claude, ChatGPT/Codex) in one table.
Grok is planned but not implemented yet.
Uses each subscription's own login (OAuth / browser session), not API keys. macOS only.

## Install

Requires Node 24.2+.

```bash
npm install
npm link        # puts `aiu` on your PATH
```

## Usage

```bash
aiu login claude --name personal    # opens the browser; paste the code shown after login
aiu login chatgpt --name pro        # opens the browser; returns automatically
aiu                                  # table of all accounts and their limits
aiu --json                           # same, machine-readable
aiu accounts                         # list configured accounts
aiu remove claude/personal           # forget an account
```

To add several accounts of the same service, switch the account in the browser
(or use a private window) before each `aiu login`.

## How it stores things

- Tokens: macOS Keychain, service `ai-usage` (never in plain files, never in process arguments).
- Account list (no secrets): `~/.config/ai-usage/accounts.json`.
- Each account has its own login, separate from Claude Code and Codex, so `aiu` never logs those tools out.

The usage endpoints are unofficial and may change without notice.

## Development

```bash
npm test
npm run typecheck
```

`npm ci` wires a pre-push hook that runs the typecheck and tests before each
push (`HOOK_SKIP=1 git push` skips it). CI runs the same checks on every PR.
