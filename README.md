# aiu — AI subscription usage

Shows the current usage limits of your AI subscriptions (Claude, ChatGPT/Codex, Grok) in one table.
Uses each subscription's own login (OAuth / browser session), not API keys. macOS only.

## Install

Requires Node 24.2+.

```bash
npm install
npm link        # puts `aiu` on your PATH
```

`aiu` runs straight from this clone, so `git pull` is the whole update; the post-merge hook (see
[Development](#development)) runs `npm ci` when the dependencies changed.

## Usage

```bash
aiu login claude --name personal    # opens the browser; paste the code shown after login
aiu login chatgpt --name pro        # opens the browser; returns automatically
aiu login grok --name main          # paste the cookie header and user agent from grok.com DevTools
aiu                                  # table, recommendation and burn plan of all accounts
aiu --json                           # same, machine-readable
aiu accounts                         # list configured accounts
aiu remove claude/personal           # forget an account
```

Below the table, `aiu` recommends which account to use now per service: the one whose weekly limit
resets first (an unknown reset counts as last), so as little allowance as possible lapses unused, skipping accounts whose 5h
or weekly limit is used up, and accounts that report neither limit. Accounts with less than 10 % of their 5h window
left come last, because they would stop again within minutes, and accounts without a weekly limit come after
those with one. When no account reports a 5h or weekly limit, it says so instead of guessing. When no account is usable, it says which one frees up first. It also lists model
limits (e.g. Fable) that are used up on at least one account: where they are still available, or when
they free up first.

Last comes the `Plan`: per service, every account with weekly allowance left, in the order to use it up
(earliest weekly reset first), with the deadline and how much is left to burn. The recommended account
leads and is the only row marked `now →`; no row is when nothing is usable now. A row adds
`with Fable first` when that account still has room for a model with its own limit, and when its 5h window
frees up if it is used up. Below the rows, `Fable back:` lists when a used-up model limit resets on each
account. When no account of a service has weekly allowance left and none is usable, it gets one line
saying when an account frees up.

`aiu --json` prints the same data for scripts: each limit carries a `kind` (`session`, `weekly` or
`model`) when known, and a top-level `recommendation` object holds the advice (`providers`, `models` and
`plan`).

To add several accounts of the same service, switch the account in the browser
(or use a private window) before each `aiu login`.

Grok has no login API, so `aiu login grok` stores the `cookie` header and user agent of a logged-in
grok.com tab (the command prints where to copy them). Paid plans show their weekly usage pool, free
accounts their query quota. The cookie cannot be refreshed: when grok.com logs it out, the row says
`Login expired` and you paste a fresh one. If Cloudflare refuses the request, the row says
`Unavailable (blocked)`.

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

`npm ci` wires two Git hooks (`HOOK_SKIP=1` skips either):

- pre-push runs the typecheck and tests before a push that changes code. CI runs the same checks on
  every PR that changes code.
- post-merge runs `npm ci` after a `git pull` that changes `package-lock.json`, so the linked `aiu`
  keeps working after an update.
