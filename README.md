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

Below the table, `aiu` recommends which account to use now per service: the one whose unused weekly
allowance lapses fastest (weekly % left per hour until its reset), skipping accounts whose 5h or weekly
limit is used up, and accounts that report neither limit. Accounts with less than 10 % of their 5h window
left come last, because they would stop again within minutes, and accounts without a weekly limit come after
those with one. When no account reports a 5h or weekly limit, it says so instead of guessing. When no account is usable, it says which one frees up first. It also lists model
limits (e.g. Fable) that are used up on at least one account: where they are still available, or when
they free up first.

`aiu --json` prints the same data for scripts: each limit carries a `kind` (`session`, `weekly` or
`model`) when known, and a top-level `recommendation` object holds the advice (`providers` and `models`).

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
