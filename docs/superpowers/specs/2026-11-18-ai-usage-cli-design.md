# AI Usage CLI — Design

Date: 2026-11-18
Status: draft, awaiting approval

## Intent

Pavel has several AI subscriptions — currently 3× Claude, 1× ChatGPT, 1× Grok —
and wants one command that shows the current usage of all of them at once:
how much of each limit is used and when it resets. Later the same data should
be reachable from a GUI button (e.g. a menu bar icon), but that is not part of
this first version.

Usage is read through the **subscription** login (the OAuth/session token the
consumer apps use), not through paid API keys.

## Goals

- `aiu` prints a table with every configured account and every limit that
  account has, split per limit (e.g. Claude: 5h session, weekly all-models,
  weekly Fable-only).
- Each account is added once via a guided login; afterwards `aiu` works
  without any interaction (tokens refresh automatically).
- `aiu --json` prints the same data machine-readable, so a future GUI can call it.
- One failing account (expired login, Cloudflare block, endpoint change) shows
  an error row; the rest still renders.

## Non-goals (for now)

- GUI / menu bar app (later, built on top of `--json`).
- History, charts, notifications, background polling.
- API-key (pay-as-you-go) billing.
- Linux / Windows support (macOS only — Keychain).
- ChatGPT web-chat message limits (no endpoint exists; we show Codex limits).

## Anti-goals (failure even if it "works")

- Logging Pavel out of Claude Code or Codex. The app must **never** refresh a
  token that those tools also use — refresh tokens rotate, so a shared one
  would invalidate the other tool's session. Each account gets its own login
  owned by this app.
- Storing tokens or cookies in plain files.
- A single broken provider making the whole command fail or hang.

## Constraints

- All endpoints are unofficial / internal. They can change without notice;
  parsers must be tolerant (unknown fields ignored, missing fields → "n/a").
- macOS, Node 24 is installed, npm (per Pavel's global rules).
- Code, identifiers, comments and CLI output in English.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A) TypeScript CLI (Node)**, own login per account, tokens in Keychain, `--json` for a future GUI | A bit more setup than a script; matches the rest of Pavel's stack; GUI can be layered on later | **Picked** |
| B) Python script | Equally quick, but no advantage and off-stack | Rejected |
| C) Menu bar plugin (SwiftBar) first | Button from day one, but harder to debug and still needs the same core | Rejected for now; possible later on top of A |

## Verified provider facts (2026-11-18)

### Claude (per account)

- `GET https://api.anthropic.com/api/oauth/usage`
  headers: `Authorization: Bearer <access_token>`, `anthropic-beta: oauth-2025-04-20`.
- Requires an OAuth token with scope `user:profile` (Claude Code's token has it).
- Response contains a generic `limits` array — **render from this array**, not
  from the legacy `five_hour` / `seven_day` fields:

```json
"limits": [
  {"kind":"session","group":"session","percent":80,"severity":"warning","resets_at":"2026-11-18T23:20:00+00:00","scope":null},
  {"kind":"weekly_all","group":"weekly","percent":70,"severity":"normal","resets_at":"2026-11-20T18:00:00+00:00","scope":null},
  {"kind":"weekly_scoped","group":"weekly","percent":100,"severity":"critical","resets_at":"2026-11-20T18:00:00+00:00",
   "scope":{"model":{"id":null,"display_name":"Fable"},"surface":null}}
]
```

  Label: `session` → "5h", `weekly_all` → "Week (all)", `weekly_scoped` →
  "Week (<scope.model.display_name>)". Unknown kinds → show `kind` as-is.
  Use the API's `severity` for colouring when present.
- Credentials as Claude Code stores them (for reference): `accessToken`,
  `refreshToken`, `expiresAt` (ms), `scopes`, `subscriptionType`,
  `rateLimitTier`. Access token lives ~8h.
- **Login (own token per account):** OAuth 2.0 Authorization Code + PKCE using
  Claude Code's public client ID, manual "paste the code" flow (Claude Code's
  `/login` does the same). Exact authorize/token URLs, client ID and redirect
  URI must be taken from the current Claude Code behaviour at build time —
  they are not verified here. Requested scopes must include `user:profile`.
- To log three different Claude accounts in, the browser must be signed into
  the right claude.ai account during each login (Pavel switches account or
  uses a private window). The app shows the email/org it got after login so a
  wrong account is caught immediately.

### ChatGPT / Codex

- `GET https://chatgpt.com/backend-api/wham/usage`
  headers: `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id: <account_id>`.
- Relevant response parts:

```json
{
  "plan_type": "pro",
  "rate_limit": {
    "limit_reached": true,
    "primary_window":   {"used_percent":100,"limit_window_seconds":604800,"reset_at":1795205991},
    "secondary_window": null
  },
  "additional_rate_limits": null,
  "model_usage": {"gpt-6-astra": {"available": false, "available_at": "2026-11-20T20:19:52Z"}}
}
```

  Label windows by length (`18000` s → "5h", `604800` s → "Week", else
  humanised). Render `additional_rate_limits` entries if present (shape not
  observed yet — tolerate anything). Render `model_usage` entries as
  "available / blocked until <time>".
- Codex stores tokens in `~/.codex/auth.json` (`tokens.access_token`,
  `refresh_token`, `id_token`, `account_id`).
- **Login (own token):** OAuth PKCE via `auth.openai.com` with Codex's public
  client ID and its localhost callback, same as `codex login`. Exact values to
  be taken from current Codex behaviour at build time.

### Grok (SuperGrok, web)

- No official usage API. Plan: `POST https://grok.com/rest/rate-limits` with a
  body naming the model/request kind, authenticated by browser cookies
  (`sso`, and whatever else grok.com currently requires). **Not verified** —
  the builder must confirm the endpoint and payload against grok.com first.
- **Login:** `aiu login grok` asks Pavel to paste the cookie header from the
  browser DevTools (with short instructions). No refresh — when the cookie
  expires, the row says so and how to fix it.
- If Cloudflare blocks server-side requests, the row shows "unavailable
  (blocked)". Acceptable for v1.

## The design

### Commands

```
aiu                         # show usage of all accounts (default)
aiu --json                  # same, as JSON
aiu login <claude|chatgpt|grok> --name <label>
aiu accounts                # list configured accounts (no secrets)
aiu remove <provider>/<label>
```

### Output (sketch)

```
$ aiu
Account          Limit          Used                    Resets
claude/personal  5h             ████████░░  80 %        in 1h12m
                 Week (all)     ███████░░░  70 %        Fri 19:00
                 Week (Fable)   ██████████ 100 %  !     Fri 19:00
claude/work      5h             █░░░░░░░░░  12 %        in 3h40m
                 ...
chatgpt/pro      Week           ██████████ 100 %  !     Fri 21:19
                 gpt-6-astra    blocked until Fri 21:19
grok/main        unavailable — cookie expired, run: aiu login grok --name main
```

Colours: green < 50 %, yellow < 80 %, red ≥ 80 % (or API `severity` when
given). Times in local time zone; "in Xh Ym" when under 24h, otherwise
weekday + time.

### Structure

- One provider module per service, each exposing the same small interface:
  `login(label)`, `fetchUsage(credentials) → { limits: Limit[], meta }`,
  and `refresh(credentials)` where applicable. A normalised `Limit` is
  `{ label, percent | remaining/total, resetsAt, severity }`.
- Renderer (table / JSON) only knows normalised limits, never provider shapes.
- All accounts fetched in parallel, ~10 s timeout each.

### Storage

- Secrets: macOS Keychain via the `security` CLI (no native dependencies),
  service `ai-usage`, account `<provider>/<label>`, value = JSON blob.
  Secrets must never appear in argv (visible via `ps`): writes go through
  `security -i`, with the `add-generic-password -U ... -w <value>` command fed
  on **stdin** (properly quoted). Reads use `find-generic-password -w`, whose
  output arrives on stdout.
- Account list (no secrets): `~/.config/ai-usage/accounts.json`.
- After a token refresh the rotated tokens are written back to Keychain
  before the response is used.

### Testing

- Unit tests (vitest) for each provider's response parser, using the
  sanitised sample responses above as fixtures, plus a missing-fields case.
- Renderer test for the table and JSON output.
- No tests hitting real endpoints; manual smoke test with real accounts.

### Coexistence with Claude Code / Codex logins

A second OAuth login with the same public client ID for the same user is the
same situation as using Claude Code or Codex on two machines, which works
concurrently, so separate grants are expected to coexist. Still, verify it
before relying on it:

1. First login test with a Claude account that is **not** the one Claude Code
   uses on this Mac; then the main one; check `claude` still works afterwards.
   Same check for ChatGPT with `codex`.
2. If a collision does show up, fall back for that provider to **read-only
   import**: read the access token from Claude Code's Keychain entry /
   `~/.codex/auth.json`, never refresh it, and show the row as "stale — open
   Claude Code/Codex to refresh" when it is expired.

## Calls made by Claude (Pavel can override)

- Grant-coexistence verification order and read-only fallback (section above).
- Keychain writes via `security -i` on stdin, so no tokens in argv.

- CLI output in English (Pavel's sketch was in Czech; trivial to change).
- Command name `aiu`, installed with `npm link`.
- Own login per account rather than importing Claude Code / Codex tokens
  (avoids logging those tools out).
- Minimal dependencies; Node built-ins (`parseArgs`, `fetch`) where they suffice.
- The project gets its own git repository (`~/DEV/ai-usage-app` currently sits
  inside the home-directory repo).

## Left to the builder

- Exact OAuth parameters for Claude and OpenAI (take from current Claude Code /
  Codex behaviour), Grok endpoint verification.
- Project layout, build setup (tsx vs compiled), table formatting details.
