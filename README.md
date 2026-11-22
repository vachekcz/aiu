# aiu — AI subscription usage

Shows the current usage limits of your AI subscriptions (Claude, ChatGPT/Codex, Grok) in one table,
and whether their CLI tools have an update.
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
aiu login claude                     # opens the browser; paste the code shown after login
aiu login chatgpt                    # opens the browser; returns automatically
aiu login grok --name main           # paste the cookie header and user agent from grok.com DevTools
aiu                                  # which account to use now, then all accounts in burn order
aiu --json                           # same, machine-readable
aiu accounts                         # list configured accounts
aiu remove claude/me@example.com     # forget an account
aiu update                           # update the claude, codex and grok CLIs
aiu update claude                    # update just one (or several: aiu update codex grok)
```

`aiu` prints two sections:

![aiu output: Use now names the Claude account to work on and says ChatGPT is used up; Accounts lists three Claude accounts and one ChatGPT account in burn order](docs/examples/typical.svg)

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
Bars are green below 50 %, orange from 50 % and red from 80 %; a used-up limit is always red. Each
model with its own limit (e.g. Fable) gets a column: a used-up model shows `✗ used` when it comes back with
the weekly reset, `✗` with its own countdown when it comes back at another time, and `✗ unknown` when
that time is not known. `Fable first` marks the first account in the
order that still has room for it. `Burn` is how much of the weekly allowance is left, coloured by the
pace needed to use it up before the reset: green below 1.5 %/h, orange up to 3 %/h, red above, and the
note names that pace once it is 1.5 %/h or more.

Terminals that announce 24-bit colour (`COLORTERM=truecolor` or `24bit`) show exactly the shades of
the images in this README. Other terminals get their theme's basic red, green, yellow and cyan instead,
and `NO_COLOR` or piping the output turns colour off. The shades are made for a dark background; on a
light one, run `COLORTERM= aiu` to keep your theme's colours.

### What it shows in other situations

The images below are the real output for made-up accounts, rendered by `npm run docs:examples`.

**The account due first has a full 5h window.** It keeps its place in the order, marked `‖` with the
time its window frees up. `▶` moves to the next account, and `Use now` says when to switch back.

![aiu output with the first Claude account waiting for its 5h window](docs/examples/session-full.svg)

**A weekly limit is used up.** The account moves below the burn order with `✗` and the time it frees up.
Its used-up limits stay red, the rest of the row is dimmed.

![aiu output with one Claude account whose weekly limit is used up](docs/examples/weekly-used-up.svg)

**Allowance is about to lapse.** The order stays by deadline, but `Burn` turns orange or red when the
pace needed before the reset gets high, and the note names that pace.

![aiu output with 65 % left 9 hours before the reset, shown in red as needing 7.2 %/h](docs/examples/lapse-risk.svg)

**Nothing is usable right now.** `Use now` says which account frees up first and when. Accounts waiting
for their 5h window stay in the order, the one with a used-up week goes below it.

![aiu output where every Claude account is waiting, and ChatGPT is usable](docs/examples/nothing-usable.svg)

**Errors and missing data.** A failed account is listed last with the command that fixes it, an account
without a known reset goes after the ones with one, and a service whose accounts all failed says so.

![aiu output with an expired Claude login, an unknown reset and a blocked Grok account](docs/examples/errors.svg)

`aiu --json` prints the same data for scripts: each limit carries a `kind` (`session`, `weekly` or
`model`) when known, and a top-level `recommendation` object holds the advice (`providers`, `models` and
`plan`).

Without `--name`, `aiu login` labels a Claude or ChatGPT account with the e-mail it logged in with,
e.g. `claude/me@example.com`. Logging in again to an account `aiu` already knows, even one added under
another label, renews that account instead of adding it twice. Pass `--name` for a shorter label, or
when one e-mail has several subscriptions (e.g. a personal and a team plan) and each needs its own
label. `--name` uses exactly the label given, so to rename an account, log in with the new name and
remove the old entry (`aiu remove claude/me@example.com`). Grok does not report the e-mail, so
`aiu login grok` always needs `--name`.

To add several accounts of the same service, switch the account in the browser
(or use a private window) before each `aiu login`.

Grok has no login API, so `aiu login grok` stores the `cookie` header and user agent of a logged-in
grok.com tab (the command prints where to copy them). Paid plans show their weekly usage pool, free
accounts their query quota. The cookie cannot be refreshed: when grok.com logs it out, the row says
`Login expired` and you paste a fresh one. If Cloudflare refuses the request, the row says
`Unavailable (blocked)`.

### CLI tool versions

When `claude`, `codex` or `grok` is installed, the output ends with a `Tools` section: the installed
version of each tool and, in orange, the newer version when there is one.

![aiu output ending with a Tools section: claude and codex have a newer version, grok is up to date](docs/examples/tools.svg)

The latest versions come from the npm registry (`claude`, `codex`) and from `grok update --check`. They
are looked up at most once a day, in parallel with the usage, and a lookup that fails or takes more than
3 seconds just leaves the newer version out. `aiu --json` lists the same under `tools`.

`aiu update` runs each tool's own `update` command, one tool after another, and prints what happened:

```
  claude   2.1.330 → 2.1.341   ✓ updated
  codex    0.171.0             ! failed: npm exited with code 1
  grok     1.0.89              ✓ already latest
```

Name the tools to update only those (`chatgpt` also means `codex`). A tool that is already up to date is
not run. One failing tool does not stop the others; the command then exits with code 1.

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
