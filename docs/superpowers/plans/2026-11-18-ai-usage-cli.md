# AI Usage CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `aiu` command that shows current subscription usage limits for several Claude, ChatGPT (Codex) and Grok accounts, as a table or JSON.

**Architecture:** One provider module per service behind a common `Provider` interface (login / needsRefresh / refresh / fetchUsage). A collector fetches all accounts in parallel, refreshes tokens under a per-account file lock and writes rotated tokens back to the macOS Keychain. Renderers only see normalised `Limit` objects.

**Tech Stack:** Node 24 running TypeScript directly (native type stripping, no build step), npm, vitest, `security` CLI for Keychain. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-ai-usage-cli-design.md`

## Global Constraints

- macOS only; Node `>=24`; npm; zero runtime dependencies (devDependencies: `typescript`, `vitest`, `@types/node`).
- TypeScript must be erasable-only (no `enum`, no `namespace`, no constructor parameter properties); relative imports use `.ts` extensions.
- Code, identifiers, comments and all CLI output in English.
- Secrets (tokens, cookies) never in plain files and never in a process's argv.
- Never read, refresh or modify Claude Code's or Codex's own credentials.
- Parsers tolerate unknown and missing fields: missing → limit omitted or `n/a`, never a crash.
- One failing account must not fail or hang the whole command (10 s timeout per account).
- Commits: English, imperative mood, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feature/initial-cli`.

## Review Focus

1. **Two `aiu` runs at once refreshing the same account** (later: GUI polling while CLI runs) — refresh tokens rotate, so the loser would be logged out. Expect a per-account lock and re-reading credentials after acquiring it. Test in Task 5.
2. **Secret longer than `security -i`'s ~4 KB line limit** (verified: 8000 chars get truncated, 3868 pass) — expect chunked storage that round-trips. Test in Task 2.
3. **Provider response missing fields or with new ones** (`{}`, `limits: null`, unknown `kind`) — expect partial output, no crash. Tests in Tasks 3, 4.
4. **Refresh token expired/revoked (refresh returns 400/401)** — expect an error row with `aiu login <provider> --name <label>` hint while other accounts render. Test in Task 5.
5. **Output piped / non-TTY (future SwiftBar) or `NO_COLOR` set** — expect no ANSI escape codes. Test in Task 1.

---

## File Structure

```
package.json, tsconfig.json, .gitignore, vitest.config.ts
src/types.ts                 shared types + error classes
src/render.ts                renderTable, renderJson, formatReset, severityForPercent
src/store/keychain.ts        readSecret / writeSecret / deleteSecret (chunked, stdin)
src/store/credentials.ts     JSON credentials on top of keychain
src/store/accounts.ts        accounts.json (no secrets)
src/oauth/pkce.ts            PKCE + state generation, JWT payload decode
src/oauth/callbackServer.ts  one-shot localhost callback server
src/providers/claude.ts
src/providers/chatgpt.ts
src/providers/grok.ts
src/providers/index.ts       providers registry
src/collect.ts               collectUsage (parallel, lock, refresh, retry, timeout)
src/lock.ts                  withFileLock
src/cli.ts                   entry point, commands
tests/**                     mirrors src, fixtures in tests/fixtures
```

---

### Task 1: Project setup, shared types, renderer

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`, `src/types.ts`, `src/render.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export type ProviderId = 'claude' | 'chatgpt' | 'grok';
  export type Severity = 'normal' | 'warning' | 'critical';
  export interface Limit { label: string; percent: number | null; resetsAt: Date | null; severity: Severity; detail?: string }
  export interface Account { provider: ProviderId; label: string; identity?: string }
  export const accountId = (account: Pick<Account, 'provider' | 'label'>): string => `${account.provider}/${account.label}`;
  export interface UsageSnapshot { plan?: string; limits: Limit[] }
  export type AccountUsage =
    | { account: Account; status: 'ok'; plan?: string; limits: Limit[] }
    | { account: Account; status: 'error'; message: string; hint?: string };
  export interface LoginIO { print(message: string): void; prompt(question: string): Promise<string>; openUrl(url: string): Promise<void> }
  export interface LoginResult<C> { credentials: C; identity?: string }
  export interface Provider<C> {
    id: ProviderId;
    login(io: LoginIO): Promise<LoginResult<C>>;
    needsRefresh(credentials: C, now: Date): boolean;
    refresh(credentials: C): Promise<C>;            // throws AuthExpiredError on 400/401
    fetchUsage(credentials: C, signal: AbortSignal): Promise<UsageSnapshot>;
  }
  export class AuthExpiredError extends Error {}    // login no longer valid
  export class BlockedError extends Error {}        // e.g. Cloudflare challenge
  ```
- Produces (`src/render.ts`):
  - `severityForPercent(percent: number): Severity` — `<50` normal, `<80` warning, `>=80` critical.
  - `formatReset(resetsAt: Date | null, now: Date): string` — `null` → `""`; past → `"now"`; under 1 h → `"in 45m"`; under 24 h → `"in 1h12m"` (no zero padding); otherwise local `"Fri 19:00"` (en-US short weekday, 24-hour).
  - `renderTable(usages: AccountUsage[], now: Date, options: { color: boolean }): string`
  - `renderJson(usages: AccountUsage[], now: Date): string`
  - `shouldUseColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): boolean` — true only if `isTTY` and `NO_COLOR` unset.

- [ ] **Step 1: Set up the project**

`package.json`: `"name": "ai-usage"`, `"type": "module"`, `"private": true`, `"bin": { "aiu": "./src/cli.ts" }`, `"engines": { "node": ">=24" }`, scripts `test: vitest run`, `typecheck: tsc --noEmit`. Install devDeps with npm. `tsconfig.json`: `strict`, `module`/`moduleResolution` `nodenext`, `target` `esnext`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `types: ["node"]`. `.gitignore`: `node_modules/`.

- [ ] **Step 2: Write failing tests** in `tests/render.test.ts`, with `now = new Date('2026-11-18T22:00:00Z')` and `TZ=Europe/Prague` set in `vitest.config.ts` (`test.env`):
  - `severityForPercent(49) === 'normal'`, `(50) === 'warning'`, `(79) === 'warning'`, `(80) === 'critical'`.
  - `formatReset(null, now) === ''`; `+30 min → 'in 30m'`; `+1h12m → 'in 1h12m'`; `-1 min → 'now'`; `2026-11-20T18:00:00Z → 'Fri 19:00'`.
  - `renderTable` for one ok account (`claude/personal`, limits `5h` 80 % critical, `Week (Fable)` 100 % critical) and one error account (`grok/main`, message `cookie expired`, hint `aiu login grok --name main`) with `color: false`: contains `claude/personal`, `████████░░`, ` 80 %`, `██████████`, `100 %`, `!` on critical rows, `in 1h20m`, and line `grok/main` + `cookie expired` + `aiu login grok --name main`; account id printed only on its first row.
  - Limit with `percent: null` and `detail: 'blocked'` renders the detail instead of a bar.
  - `renderTable(..., { color: false })` output contains no `\x1b[`; with `color: true` it does.
  - `shouldUseColor({ isTTY: false }, {}) === false`, `({ isTTY: true }, { NO_COLOR: '1' }) === false`, `({ isTTY: true }, {}) === true`.
  - `JSON.parse(renderJson(...))` equals `{ generatedAt: now.toISOString(), accounts: [{ id: 'claude/personal', provider: 'claude', label: 'personal', status: 'ok', plan, limits: [{ label, percent, resetsAt: ISO string | null, severity, detail }] }, { id: 'grok/main', ..., status: 'error', message, hint }] }`.

- [ ] **Step 3: Run** `npm test` — expected: FAIL (modules missing).

- [ ] **Step 4: Implement `src/types.ts` and `src/render.ts`** per Interfaces. Bar: 10 cells, filled = `Math.round(percent / 10)`, `█`/`░`. Columns: Account, Limit, Used, Resets — padded to the widest value. Colours (only when `color`): green normal, yellow warning, red critical, dim for error hints.

- [ ] **Step 5: Run** `npm test && npm run typecheck` — expected: PASS, no type errors.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "Add project setup, shared types and table/JSON renderer"`

---

### Task 2: Keychain and account stores

**Files:**
- Create: `src/store/keychain.ts`, `src/store/credentials.ts`, `src/store/accounts.ts`
- Test: `tests/store/keychain.test.ts`, `tests/store/accounts.test.ts`

**Interfaces:**
- Produces:
  - `readSecret(account: string): Promise<string | null>`, `writeSecret(account: string, value: string): Promise<void>`, `deleteSecret(account: string): Promise<void>` — Keychain service name from `process.env.AI_USAGE_KEYCHAIN_SERVICE ?? 'ai-usage'`.
  - `loadCredentials<C>(id: string): Promise<C | null>`, `saveCredentials<C>(id: string, credentials: C): Promise<void>`, `deleteCredentials(id: string): Promise<void>` — JSON over the secret functions.
  - `configDir(): string` — `process.env.AI_USAGE_CONFIG_DIR ?? ~/.config/ai-usage`.
  - `listAccounts(): Promise<Account[]>` (missing file → `[]`), `upsertAccount(account: Account): Promise<void>` (replace by id, keep order, append new), `removeAccount(id: string): Promise<boolean>`.

- [ ] **Step 1: Write failing tests.** Keychain tests run against the real Keychain with `AI_USAGE_KEYCHAIN_SERVICE=ai-usage-test` and delete their items in `afterEach`:
  - round-trip of a short JSON string;
  - round-trip of an 8000-char random string (Review Focus 2);
  - overwrite an 8000-char value with a 10-char value, then `readSecret` returns the 10-char value and no stale chunk items remain (`security find-generic-password -s ai-usage-test -a '<id>#2'` exits non-zero);
  - `readSecret` of a missing account → `null`;
  - spawned `security` processes never receive the secret in argv: mock `node:child_process` and assert no argv element contains the value.
  Accounts tests use a temp `AI_USAGE_CONFIG_DIR`: empty list when file missing; upsert adds then replaces (identity updated, order kept); remove returns `true`/`false`.

- [ ] **Step 2: Run** `npm test` — expected: FAIL.

- [ ] **Step 3: Implement.** Storage format: value → base64 → chunks of 3000 chars stored as items `<id>#0..n-1`; head item `<id>` holds `chunks:<n>`. Write chunks first, then head, then delete leftover `<id>#n...` until one is missing. Writes go through `spawn('security', ['-i'])` with lines `add-generic-password -U -s "<service>" -a "<item>" -w "<base64chunk>"` on stdin (base64 and validated ids need no escaping); reject on non-zero exit. Reads use `execFile('security', ['find-generic-password', '-s', service, '-a', item, '-w'])`; exit code 44 → not found. `accounts.json` is written atomically (write temp file + rename), dir created with mode `0700`.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — expected: PASS.

- [ ] **Step 5: Commit** — `Add Keychain-backed credential store and accounts list`

---

### Task 3: Claude provider

**Files:**
- Create: `src/oauth/pkce.ts`, `src/providers/claude.ts`, `tests/fixtures/claude-usage.json`
- Test: `tests/providers/claude.test.ts`, `tests/oauth/pkce.test.ts`

**Interfaces:**
- Produces (`src/oauth/pkce.ts`): `createPkce(): { verifier: string; challenge: string }` (S256, base64url, verifier 64 random bytes), `createState(): string`, `decodeJwtPayload(token: string): Record<string, unknown>`.
- Produces (`src/providers/claude.ts`):
  - `interface ClaudeCredentials { accessToken: string; refreshToken: string; expiresAt: number }` (ms epoch)
  - `parseClaudeUsage(json: unknown): UsageSnapshot`
  - `buildClaudeAuthorizeUrl(challenge: string, state: string): string`
  - `claudeProvider: Provider<ClaudeCredentials>`
- Constants (verified from Claude Code 2.1.327):
  - `CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'`
  - `AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'`
  - `TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'`
  - `REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'` (manual paste flow)
  - `SCOPES = ['user:profile', 'user:inference']`
  - `USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'`, header `anthropic-beta: oauth-2025-04-20`

- [ ] **Step 1: Create fixture** `tests/fixtures/claude-usage.json` with the `limits` array from the spec (session 80 / warning, weekly_all 70 / normal, weekly_scoped Fable 100 / critical) plus `"five_hour": {"utilization": 80.0, "resets_at": "2026-11-18T23:20:00+00:00"}`, `"seven_day": {"utilization": 70.0, "resets_at": "2026-11-20T18:00:00+00:00"}` and an unknown field `"nimbus_quill": null`.

- [ ] **Step 2: Write failing tests:**
  - fixture → limits `[{label:'5h', percent:80, severity:'warning'}, {label:'Week (all)', percent:70, severity:'normal'}, {label:'Week (Fable)', percent:100, severity:'critical'}]` with `resetsAt` as `Date`s.
  - unknown kind `{"kind":"monthly_x","percent":10}` → label `monthly_x`, severity from percent.
  - severity missing → `severityForPercent`.
  - no `limits` array → falls back to `five_hour` → `5h` and `seven_day` → `Week (all)`.
  - `{}` and `null` → `{ limits: [] }` without throwing.
  - `buildClaudeAuthorizeUrl('ch', 'st')` has origin+path of `AUTHORIZE_URL` and params `code=true`, `client_id`, `response_type=code`, `redirect_uri=REDIRECT_URI`, `scope='user:profile user:inference'`, `code_challenge=ch`, `code_challenge_method=S256`, `state=st`.
  - `login` with a fake `LoginIO` whose `prompt` returns `'thecode#<state>'` and mocked `fetch` → POSTs JSON `{grant_type:'authorization_code', code:'thecode', redirect_uri, client_id, code_verifier, state}` to `TOKEN_URL`; returns credentials with `expiresAt = now + expires_in*1000`, identity from `account.email_address` when present. Pasted state mismatch → throws `Error('OAuth state mismatch')`.
  - `refresh` POSTs `{grant_type:'refresh_token', refresh_token, client_id, scope:'user:profile user:inference'}`; keeps the old refresh token when the response has none; HTTP 400/401 → `AuthExpiredError`.
  - `needsRefresh` true when `expiresAt - 60_000 <= now`.
  - `fetchUsage` sends `Authorization: Bearer`, `anthropic-beta`; 401 → `AuthExpiredError`; other non-2xx → `Error('Claude usage HTTP <status>')`.
  - pkce: challenge equals base64url(sha256(verifier)); `decodeJwtPayload` of a hand-built JWT returns its payload.

- [ ] **Step 3: Run** `npm test` — expected: FAIL.

- [ ] **Step 4: Implement.** `login`: create PKCE+state, `io.print` instructions ("Sign in with the Claude account you want to add — use a private window or switch accounts first"), `io.openUrl(url)`, `io.prompt('Paste the code shown after login: ')`, split on `#`, verify state, exchange.

- [ ] **Step 5: Run** `npm test && npm run typecheck` — expected: PASS.

- [ ] **Step 6: Commit** — `Add Claude provider with OAuth login and usage parser`

---

### Task 4: ChatGPT (Codex) provider

**Files:**
- Create: `src/oauth/callbackServer.ts`, `src/providers/chatgpt.ts`, `tests/fixtures/chatgpt-usage.json`
- Test: `tests/providers/chatgpt.test.ts`, `tests/oauth/callbackServer.test.ts`

**Interfaces:**
- Consumes: `createPkce`, `createState`, `decodeJwtPayload` (Task 3), types (Task 1).
- Produces:
  - `waitForOAuthCallback(options: { port: number; path: string; expectedState: string; timeoutMs: number }): { ready: Promise<void>; code: Promise<string> }` — serves one request, replies with a small "You can close this tab" HTML page, closes. `EADDRINUSE` → `Error('Port 1455 is busy — is `codex login` running?')`.
  - `interface ChatGptCredentials { accessToken: string; refreshToken: string; accountId: string; expiresAt: number }`
  - `parseChatGptUsage(json: unknown): UsageSnapshot`, `windowLabel(seconds: number): string`
  - `chatgptProvider: Provider<ChatGptCredentials>`
- Constants (verified from Codex binary):
  - `CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'`, `ISSUER = 'https://auth.openai.com'`
  - authorize `${ISSUER}/oauth/authorize`, token `${ISSUER}/oauth/token`
  - `REDIRECT_URI = 'http://localhost:1455/auth/callback'` (port fixed — registered redirect)
  - `SCOPE = 'openid profile email offline_access'`
  - extra authorize params: `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs`
  - `USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'`, headers `Authorization: Bearer`, `ChatGPT-Account-Id`, `User-Agent: codex_cli_rs`

- [ ] **Step 1: Create fixture** from the spec's ChatGPT sample (`plan_type: "pro"`, primary window 100 % / 604800 s / `reset_at: 1795205991`, `secondary_window: null`, `additional_rate_limits: null`, `model_usage.gpt-6-astra` unavailable until `2026-11-20T20:19:52Z`).

- [ ] **Step 2: Write failing tests:**
  - fixture → `plan: 'pro'`, limits `[{label:'Week', percent:100, severity:'critical', resetsAt: new Date(1795205991*1000)}, {label:'gpt-6-astra', percent:null, severity:'critical', detail:'blocked', resetsAt: new Date('2026-11-20T20:19:52Z')}]`.
  - both windows present (18000 s and 604800 s) → `5h` then `Week`; `windowLabel(18000)==='5h'`, `(604800)==='Week'`, `(86400)==='1d'`, `(7200)==='2h'`.
  - available model → `detail:'available'`, severity `normal`, `resetsAt:null`.
  - `additional_rate_limits: [{ limit_name: 'GPT-6 Pro', rate_limit: { primary_window: {...} } }]` → extra limit labelled `GPT-6 Pro Week`; an entry of unexpected shape is skipped.
  - `{}` / `null` → `{ limits: [] }`.
  - `login` with fake IO: the opened URL has all params above; simulate the browser by requesting `http://localhost:1455/auth/callback?code=c&state=<state>`; token exchange is form-urlencoded `grant_type=authorization_code&code=c&redirect_uri&client_id&code_verifier`; `accountId` from id_token claim `["https://api.openai.com/auth"].chatgpt_account_id`, identity from claim `email`, `expiresAt` from the access token's `exp` claim × 1000.
  - callback with wrong state → rejects `OAuth state mismatch`; second server on a busy port → the port-busy error.
  - `refresh` POSTs JSON `{client_id, grant_type:'refresh_token', refresh_token, scope:'openid profile email'}`; 400/401 → `AuthExpiredError`.
  - `fetchUsage` sends the three headers; 401 → `AuthExpiredError`.

- [ ] **Step 3: Run** `npm test` — expected: FAIL.

- [ ] **Step 4: Implement** per Interfaces. `login` prints "Sign in with the ChatGPT account you want to add", starts the callback server, waits for `ready`, opens the URL, awaits the code (timeout 5 min).

- [ ] **Step 5: Run** `npm test && npm run typecheck` — expected: PASS.

- [ ] **Step 6: Commit** — `Add ChatGPT (Codex) provider with OAuth login and usage parser`

---

### Task 5: Usage collector with locking and refresh

**Files:**
- Create: `src/lock.ts`, `src/collect.ts`, `src/providers/index.ts`
- Test: `tests/lock.test.ts`, `tests/collect.test.ts`

**Interfaces:**
- Consumes: `Provider`, `AccountUsage`, `AuthExpiredError`, `BlockedError` (Task 1); `loadCredentials`, `saveCredentials`, `configDir` (Task 2).
- Produces:
  - `withFileLock<T>(name: string, fn: () => Promise<T>, options?: { timeoutMs?: number; staleMs?: number }): Promise<T>` — lock file `<configDir>/locks/<name>.lock` created with `wx`; retries every 50 ms up to `timeoutMs` (default 15 000); a lock older than `staleMs` (default 60 000) is removed. Name is the account id with `/` replaced by `__`.
  - `providers: Record<ProviderId, Provider<any>>` in `src/providers/index.ts` (Grok added in Task 7; until then the registry contains claude and chatgpt).
  - `collectUsage(accounts: Account[], deps: CollectDeps): Promise<AccountUsage[]>` — results in input order.
  - `interface CollectDeps { providers: Partial<Record<ProviderId, Provider<any>>>; loadCredentials: (id: string) => Promise<unknown | null>; saveCredentials: (id: string, c: unknown) => Promise<void>; now: () => Date; timeoutMs: number; lock: typeof withFileLock }`

- [ ] **Step 1: Write failing tests** with fake providers and in-memory credential store:
  - two accounts fetched in parallel (fake provider records start times; both start before either resolves).
  - expired credentials → `refresh` called once, `saveCredentials` called with the new credentials **before** `fetchUsage`, fetch uses new token.
  - `fetchUsage` throws `AuthExpiredError` on a fresh token → one refresh + retry; second `AuthExpiredError` → error row, no third attempt.
  - `refresh` throws `AuthExpiredError` → `{status:'error', message:'Login expired', hint:'aiu login claude --name personal'}` and the other account is still `ok` (Review Focus 4).
  - missing credentials → error `No credentials stored`, hint as above.
  - `BlockedError` → message `Unavailable (blocked)`; provider hanging longer than `timeoutMs` → message `Timed out`; unknown provider id → message `Unknown provider`.
  - concurrency (Review Focus 1): two `collectUsage` calls on the same expired account with the real `withFileLock` (temp config dir) → `refresh` called exactly once; the second run re-reads credentials after taking the lock and sees them fresh.
  - lock: second holder waits until the first releases; stale lock file (mtime older than `staleMs`) is taken over.

- [ ] **Step 2: Run** `npm test` — expected: FAIL.

- [ ] **Step 3: Implement.** Per account: `lock(id, async () => { load → if needsRefresh: refresh + save → fetch with AbortSignal.timeout(timeoutMs) → on AuthExpiredError (once): refresh + save + fetch })`, wrapped in try/catch mapping errors to rows. The lock is held for the whole per-account cycle (simple; accounts are independent, so parallelism across accounts is unaffected).

- [ ] **Step 4: Run** `npm test && npm run typecheck` — expected: PASS.

- [ ] **Step 5: Commit** — `Add parallel usage collector with token refresh and file lock`

---

### Task 6: CLI commands, install, real-account smoke test

**Files:**
- Create: `src/cli.ts` (shebang `#!/usr/bin/env node`), `README.md` (install + usage, short)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `main(argv: string[], deps?: Partial<CliDeps>): Promise<number>` (exit code), invoked at the bottom of `cli.ts` only when run as entry point (`import.meta.main`).

Commands (via `node:util` `parseArgs`):
- `aiu` / `aiu --json` — list accounts, `collectUsage`, print table (colour per `shouldUseColor(process.stdout, process.env)`) or JSON. No accounts → `No accounts yet. Add one with: aiu login <claude|chatgpt|grok> --name <label>`, exit 0. Exit code 0 even if some rows are errors.
- `aiu login <provider> --name <label>` — label must match `/^[a-z0-9][a-z0-9_-]{0,31}$/` (else exit 2 with message); runs `provider.login`, `saveCredentials`, `upsertAccount` (re-login replaces), prints `Added <id> (<identity>)`.
- `aiu accounts` — one line per account: `<id>  <identity or "">`.
- `aiu remove <provider>/<label>` — deletes credentials + account; unknown id → exit 1 `No such account: <id>`.
- `aiu --help` / unknown command → usage text, exit 0 / 2.

- [ ] **Step 1: Write failing tests** for `main` with injected deps (fake providers, in-memory stores, captured stdout/stderr): default table, `--json` parses, empty-accounts message, invalid label → 2, login stores credentials and account with identity, remove unknown → 1, unknown command → 2.

- [ ] **Step 2: Run** `npm test` — expected: FAIL.

- [ ] **Step 3: Implement `src/cli.ts`.** Real `LoginIO`: `print` → stderr, `prompt` → `node:readline/promises`, `openUrl` → `execFile('open', [url])`.

- [ ] **Step 4: Run** `npm test && npm run typecheck` — expected: PASS.

- [ ] **Step 5: Install and check the binary.** `chmod +x src/cli.ts && npm link`, then `aiu --help`. Expected: usage text, and **no** `ExperimentalWarning` on stderr. If a warning appears, change the shebang to `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning`. If Node refuses to strip types because the path resolves under `node_modules`, replace the bin with a tiny `bin/aiu` shell script that `exec node "$(dirname "$(realpath "$0")")/../src/cli.ts" "$@"`.

- [ ] **Step 6: Real-account smoke test with Pavel (interactive — needs him at the browser).** Order matters (spec, "Coexistence"):
  1. `claude --version` and a trivial `claude -p "hi"` work before starting.
  2. `aiu login claude --name <a Claude account NOT used by Claude Code on this Mac>` → `aiu` shows its 3 limits.
  3. `claude -p "hi"` still works. Then log in the other Claude accounts, including the main one; re-check `claude -p "hi"`.
  4. `codex login status` OK → `aiu login chatgpt --name <label>` → `codex login status` still OK.
  5. Run `aiu` and `aiu --json | head`; compare values with Claude Code `/usage` and Codex `/status`.
  If step 3 or 4 shows a logout: stop, tell Pavel, and switch that provider to the read-only fallback described in the spec before continuing.

- [ ] **Step 7: Commit** — `Add aiu CLI commands and README`

---

### Task 7: Grok provider (discovery first)

**Files:**
- Create: `src/providers/grok.ts`, `tests/fixtures/grok-rate-limits.json`
- Modify: `src/providers/index.ts` (register grok)
- Test: `tests/providers/grok.test.ts`

**Interfaces:**
- Produces: `interface GrokCredentials { cookie: string; userAgent: string }`, `parseGrokRateLimits(model: string, json: unknown): Limit | null`, `grokProvider: Provider<GrokCredentials>` (`needsRefresh` always false; `refresh` throws `AuthExpiredError`).

- [ ] **Step 1: Discovery with Pavel's real cookie (no code yet).** Pavel opens grok.com logged in → DevTools → Network → any `grok.com/rest/...` request → copies the `cookie` request header, and `navigator.userAgent` from Console. Store them in a scratch shell variable only. Try `POST https://grok.com/rest/rate-limits` with `content-type: application/json`, `cookie`, `user-agent`, `origin: https://grok.com`, `referer: https://grok.com/`, body `{"requestKind":"DEFAULT","modelName":"grok-4"}`. Record: status, whether a Cloudflare challenge page comes back, response shape, and which `modelName`s the web app itself sends (from the Network tab). Save one sanitised response as the fixture. If every attempt is Cloudflare-blocked, stop here and report to Pavel — the row will show `Unavailable (blocked)`; implement only the BlockedError path.

- [ ] **Step 2: Write failing tests** based on the recorded shape: a limit per model with `percent = (total - remaining) / total * 100`, `detail: '<remaining>/<total> left'`, `resetsAt: null`; missing fields → `null` (skipped); HTML body containing `Just a moment` or `cf-` challenge markers → `BlockedError`; 401/403 without challenge → `AuthExpiredError`; `login` prompts for the cookie header and the user agent and returns them (identity omitted).

- [ ] **Step 3: Run** `npm test` — expected: FAIL.

- [ ] **Step 4: Implement** `src/providers/grok.ts`; `fetchUsage` queries each model from the discovery list in parallel; register in `src/providers/index.ts`.

- [ ] **Step 5: Run** `npm test && npm run typecheck`, then `aiu login grok --name main` with Pavel and `aiu` — expected: Grok rows (or a clean `Unavailable (blocked)` row).

- [ ] **Step 6: Commit** — `Add Grok provider`
