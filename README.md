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
aiu                                  # which account to use now, then all accounts in burn order
aiu --json                           # same, machine-readable
aiu accounts                         # list configured accounts
aiu remove claude/personal           # forget an account
```

`aiu` prints two sections:

```
Use now  which account to work on right now
  ▶ Claude   use pvachek@example.com — 22 % lapses in 22h 18m · 5h 80 % free
  ✗ ChatGPT  nothing usable — back in 1d 0h on me@example.com

Accounts  burn top to bottom: earliest weekly reset first
    Claude               5h           Week              Fable        Resets in  Burn
  ▶ pvachek@example.com  █░░░░  20 %  ████████░░  78 %  ✗ used       22h 18m     22 %
    info@example.com     ░░░░░   0 %  ████████░░  79 %  ✗ used       4d 0h       21 %
    work@example.com     ░░░░░   3 %  █░░░░░░░░░   9 %    0 %        6d 19h      91 %  Fable first

    ChatGPT              5h           Week              gpt-6-astra  Resets in  Burn
  ✗ me@example.com       —            ██████████ 100 %  ✗ used       1d 0h      —      week used up · back in 1d 0h
```

`Use now` names, per service, the account to work on: the one whose weekly limit resets first (an
unknown reset counts as last), so as little allowance as possible lapses unused. It skips accounts whose
5h or weekly limit is used up and accounts that report neither limit. Accounts with less than 10 % of
their 5h window left come last, because they would stop again within minutes, and accounts without a
weekly limit come after those with one. When an account due earlier is only waiting for its 5h window,
the line says when to switch back to it. When no account is usable, it says which one frees up first.

`Accounts` lists every account per service in the order to burn its weekly allowance. `▶` marks the
account to use now, `‖` one waiting for its 5h window (it keeps its place in the order), `✗` one whose
weekly limit is used up (listed after the others, by when it frees up) and `!` one that failed, with the
command that fixes it. The columns are shared by all services, so a service without a 5h window shows `—`.
Bars are green below 50 %, yellow from 50 % and red from 80 %; a used-up limit is always red. Each
model with its own limit (e.g. Fable) gets a column, and `Fable first` marks the first account in the
order that still has room for it. `Burn` is how much of the weekly allowance is left, coloured by the
pace needed to use it up before the reset: green below 1.5 %/h, yellow up to 3 %/h, red above, and the
note names that pace once it is 1.5 %/h or more.

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
