# Usage Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Plan` section under today's `aiu` output that lists, per provider, which account to burn until when (earliest weekly reset first), and switch `Recommendation`'s account pick to the same deadline order.

**Architecture:** `recommend.ts` gains the deadline ordering and a `plan` field on `Advice`; `render.ts` gains `renderPlan`, which `cli.ts` appends after the recommendation. `--json` picks the plan up for free because it already serialises `recommend()`.

**Tech Stack:** TypeScript run directly by Node 24.2+, vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-usage-plan-design.md`

## Global Constraints

- CLI output, identifiers, comments and commit messages in English; commits in imperative mood.
- Renderer knows only the normalised `Limit` / `Advice`, never a provider's response shape.
- Tests never hit real endpoints. Tests run with `TZ=Europe/Prague` (existing fixtures rely on it: `now` = Wed 23:00 local).
- Table, `Recommendation` wording and `Model limits` stay as they are; only the account `Recommendation` picks may change.
- `npm test` and `npm run typecheck` pass on the final head.

## Review Focus

- Weekly limit with unknown reset (`resetsAt: null`): sorts after every known deadline, renders `unknown` with an empty countdown, never crashes. → Task 2 test.
- Weekly limit with `percent: null`: nothing to burn, so the account is left out of the plan. → Task 2 test.
- Account with two model limits that both have room: note reads `with A, B first`. → Task 2 test.
- Every account of a provider blocked by its 5h window: plan still lists them (with the frees-up note), while `Recommendation` says nothing is usable now. → Task 2 test.
- Provider without any weekly limit (Grok free): left out of `Plan` entirely, `Recommendation` unchanged. → Task 3 test.

---

### Task 1: Deadline order for the recommended account

**Files:**
- Modify: `src/recommend.ts` (top doc comment; sort in `adviseProvider`)
- Test: `tests/recommend.test.ts`

**Interfaces:**
- Produces: `recommend()` keeps its signature; among usable accounts with a weekly limit, ties after `hasRoom` / `hasWeekly` are broken by weekly `resetsAt` ascending, unknown reset last. Accounts without a weekly limit keep today's `urgency()` ranking among themselves.

- [ ] **Step 1: Write the failing test**

```ts
it('uses the account whose allowance lapses first, even if another needs more % per hour', () => {
  // X: 5 % left for 2h (2.5 %/h). Y: 60 % left for 10h (6 %/h). Deadline order loses nothing.
  const advice = recommend([claude('y', 0, 40, 10), claude('x', 0, 95, 2)], now);
  expect(advice.providers[0]?.accountId).toBe('claude/x');
});

it('puts an unknown weekly reset after every known one', () => {
  const advice = recommend([ok('claude', 'unknown', [limit('weekly', 'Week (all)', 10, null)]), claude('known', 0, 10, 150)], now);
  expect(advice.providers[0]?.accountId).toBe('claude/known');
});
```

Also rename `'picks the account whose unused weekly allowance lapses fastest'` to `'picks the account whose weekly allowance lapses first'` (assertions unchanged).

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run tests/recommend.test.ts`
Expected: FAIL, `expected 'claude/y' to be 'claude/x'`.

- [ ] **Step 3: Replace the `rankUrgency` tie-break for weekly accounts with weekly `resetsAt` ascending (null last); keep `urgency()` for accounts without a weekly limit. Rewrite the top doc comment to say deadline order and why (the X/Y example).**

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all pass (existing recommend/render tests pick the same accounts under deadline order).

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts
git commit -m "Recommend the account whose weekly allowance lapses first"
```

### Task 2: Plan data in `recommend()`

**Files:**
- Modify: `src/recommend.ts`
- Test: `tests/recommend.test.ts`, `tests/render.test.ts` (renderJson expectation), `tests/cli.test.ts:90`

**Interfaces:**
- Consumes: Task 1 ordering.
- Produces (exported from `src/recommend.ts`):

```ts
export interface PlanStep {
  accountId: string;
  /** Weekly % left, floored only when rendered. */
  weeklyLeft: number;
  /** Weekly reset: the deadline for this step. */
  resetsAt: Date | null;
  /** Labels of this account's model limits that still have room, e.g. ["Week (Fable)"]. */
  premium: string[];
  /** Set only when the 5h window is used up: its label and reset. */
  sessionBlocked?: { label: string; resetsAt: Date | null };
}

export interface ModelBack {
  label: string;
  accountId: string;
  at: Date | null;
}

export interface ProviderPlan {
  provider: ProviderId;
  steps: PlanStep[];
  /** Model limits used up on an account of this provider, sorted by `at`, unknown last. */
  back: ModelBack[];
}

export interface Advice {
  providers: ProviderAdvice[];
  models: ModelAdvice[];
  plan: ProviderPlan[]; // same provider order as `providers`
}
```

Step rules: an `ok` account is a step when it has a `weekly` limit with a non-null percent below 100 (`isUsedUp` false). A used-up 5h window does not exclude it; it sets `sessionBlocked`. Steps sort by `resetsAt` ascending, null last, ties in input order. A model limit has room when `isUsedUp` is false (so a ChatGPT model with `detail: 'available'` counts).

- [ ] **Step 1: Write the failing tests**

```ts
describe('plan', () => {
  it('orders accounts by weekly reset and marks free model limits and blocked 5h windows', () => {
    const { plan } = recommend(
      [
        claude('late', 33, 74, 106, 60), // Fable 40 % left
        claude('first', 3, 57, 5), // Fable used up
        ok('claude', 'blocked', [limit('session', '5h', 100, 2), limit('weekly', 'Week (all)', 73, 33), limit('model', 'Week (Fable)', 100, 33)]),
      ],
      now,
    );
    expect(plan).toEqual([
      {
        provider: 'claude',
        steps: [
          { accountId: 'claude/first', weeklyLeft: 43, resetsAt: inHours(5), premium: [] },
          { accountId: 'claude/blocked', weeklyLeft: 27, resetsAt: inHours(33), premium: [], sessionBlocked: { label: '5h', resetsAt: inHours(2) } },
          { accountId: 'claude/late', weeklyLeft: 26, resetsAt: inHours(106), premium: ['Week (Fable)'] },
        ],
        back: [
          { label: 'Week (Fable)', accountId: 'claude/first', at: inHours(5) },
          { label: 'Week (Fable)', accountId: 'claude/blocked', at: inHours(33) },
        ],
      },
    ]);
  });

  it('puts an unknown weekly reset last and skips a weekly limit without percent', () => {
    const { plan } = recommend(
      [ok('claude', 'unknown', [limit('weekly', 'Week (all)', 10, null)]), ok('claude', 'no-percent', [limit('weekly', 'Week (all)', null, 5)]), claude('known', 0, 10, 150)],
      now,
    );
    expect(plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/known', 'claude/unknown']);
  });

  it('lists every model limit with room', () => {
    const { plan } = recommend([ok('claude', 'x', [limit('weekly', 'Week (all)', 0, 50), limit('model', 'Week (Fable)', 0, 50), limit('model', 'Week (Opus)', 10, 50)])], now);
    expect(plan[0]?.steps[0]?.premium).toEqual(['Week (Fable)', 'Week (Opus)']);
  });

  it('keeps 5h-blocked accounts in the plan while the recommendation finds nothing usable', () => {
    const advice = recommend([ok('claude', 'x', [limit('session', '5h', 100, 2), limit('weekly', 'Week (all)', 50, 50)])], now);
    expect(advice.providers[0]?.accountId).toBeNull();
    expect(advice.plan[0]?.steps.map((step) => step.accountId)).toEqual(['claude/x']);
  });

  it('starts with the recommended account when it has room', () => {
    const advice = recommend([claude('a', 0, 40, 10), claude('b', 0, 95, 2), claude('c', 50, 0, 100)], now);
    expect(advice.plan[0]?.steps[0]?.accountId).toBe(advice.providers[0]?.accountId);
  });
});
```

Update existing expectations: `'returns nothing for no accounts'` → `{ providers: [], models: [], plan: [] }`; `tests/cli.test.ts:90` → `recommendation: { providers: [], models: [], plan: [] }`; the `renderJson` test in `tests/render.test.ts` gets `plan: [{ provider: 'claude', steps: [], back: [{ label: 'Week (Fable)', accountId: 'claude/personal', at: '2026-11-20T18:00:00.000Z' }] }]`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/recommend.test.ts`
Expected: FAIL, `plan` is `undefined`.

- [ ] **Step 3: Implement `planProvider(provider: ProviderId, usages: OkUsage[]): ProviderPlan` in `src/recommend.ts` and add `plan` to the object `recommend()` returns.**

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts tests/recommend.test.ts tests/render.test.ts tests/cli.test.ts
git commit -m "Add a per-provider burn plan to the recommendation"
```

### Task 3: `Plan` section in the output

**Files:**
- Modify: `src/render.ts` (new `renderPlan`), `src/cli.ts:115-116`, `README.md` (usage line for `aiu`)
- Test: `tests/render.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `Advice.plan`, `Advice.providers` from Task 2; existing `formatReset`, `formatCountdown`, `relative`, `whenFree`, `sessionName`, `PROVIDER_NAMES` in `render.ts`.
- Produces: `export function renderPlan(usages: AccountUsage[], now: Date, options: { color: boolean }): string` — empty string when no provider qualifies. `cli.ts` prints `[table, recommendation, plan].filter(Boolean).join('\n\n')`.

Format (the test below pins it):
- Heading `Plan` (bold with colour, like `Recommendation`).
- A provider is shown when it has steps, or when its `ProviderAdvice` has `accountId === null` and no `noData` (nothing usable). Otherwise it is skipped, `back` included.
- Prefix: `  ` + provider name padded to the widest shown name + `  `; continuation lines use spaces of the same width.
- Step line: lead (`now →` for the first step, `    →` after), space, deadline (`formatReset`, or `unknown` when null), countdown in parens (`(5h 0m)`, empty when null), account id, `burn N %` (`Math.floor`), note. Deadline, countdown, account and burn columns are padded to their widest value within the provider; columns are joined by two spaces; the line is `trimEnd`ed.
- Note: `with <names> first` where a name is the text inside the label's trailing parentheses (`Week (Fable)` → `Fable`) or the whole label (`gpt-6-astra`), joined by `, `; and/or `<sessionName(label)> frees up <relative or "at an unknown time">`; both joined by ` · `.
- Back line (when `back` is non-empty), one per model label: `<name> back: <formatReset(at) or unknown> on <accountId>` entries joined by ` · `.
- Nothing usable: `nothing usable · back <whenFree(availableAt)>` + ` on <availableAccountId>` when known.

- [ ] **Step 1: Write the failing tests**

```ts
describe('renderPlan', () => {
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
  const account = (label: string, limits: Limit[]): AccountUsage => ({ account: { provider: 'claude', label }, status: 'ok', limits });
  const week = (percent: number, hours: number) => ({ label: 'Week (all)', kind: 'weekly' as const, percent, resetsAt: at(hours), severity: 'normal' as const });
  const fable = (percent: number, hours: number) => ({ label: 'Week (Fable)', kind: 'model' as const, percent, resetsAt: at(hours), severity: 'normal' as const });
  const session = (percent: number, hours: number) => ({ label: '5h', kind: 'session' as const, percent, resetsAt: at(hours), severity: 'normal' as const });

  it('lists accounts by deadline with model and 5h notes, then providers with nothing usable', () => {
    const output = renderPlan(
      [
        account('c', [session(33, 3), week(74, 106), fable(60, 106)]),
        account('a', [session(3, 3), week(57, 5), fable(100, 5)]),
        account('b', [session(100, 2), week(73, 33), fable(100, 33)]),
        { account: { provider: 'chatgpt', label: 'pro' }, status: 'ok', limits: [{ label: 'Week', kind: 'weekly', percent: 100, resetsAt: at(71), severity: 'critical' }] },
      ],
      now,
      { color: false },
    );
    expect(output.split('\n')).toEqual([
      'Plan',
      '  Claude   now → Thu 04:00  (5h 0m)   claude/a  burn 43 %',
      '               → Fri 08:00  (1d 9h)   claude/b  burn 27 %  5h window frees up in 2h 0m',
      '               → Mon 09:00  (4d 10h)  claude/c  burn 26 %  with Fable first',
      '           Fable back: Thu 04:00 on claude/a · Fri 08:00 on claude/b',
      '  ChatGPT  nothing usable · back in 2d 23h (Sat 22:00) on chatgpt/pro',
    ]);
  });

  it('renders an unknown weekly reset', () => {
    const output = renderPlan([account('x', [{ ...week(10, 0), resetsAt: null }])], now, { color: false });
    expect(output).toContain('now → unknown');
    expect(output).toContain('claude/x  burn 90 %');
  });

  it('skips providers without a weekly limit and is empty when none is left', () => {
    const grok: AccountUsage = { account: { provider: 'grok', label: 'free' }, status: 'ok', limits: [{ label: '2h', kind: 'session', percent: 25, resetsAt: null, severity: 'normal' }] };
    expect(renderPlan([grok], now, { color: false })).toBe('');
  });
});
```

(Import `Limit` from `../src/types.ts`.)

In `tests/cli.test.ts`, add `'prints the plan after the recommendation'`: same setup as `'prints the usage table by default'`, but with a provider whose `fetchUsage` returns `{ label: 'Week (all)', kind: 'weekly', percent: 40, resetsAt: <NOW + 10h>, severity: 'normal' }`; assert `stdout.indexOf('Plan')` is greater than `stdout.indexOf('Recommendation')` and `stdout` contains `claude/personal  burn 60 %`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/render.test.ts tests/cli.test.ts`
Expected: FAIL, `renderPlan` is not exported.

- [ ] **Step 3: Implement `renderPlan` in `src/render.ts`, wire it in `src/cli.ts`, and change the README usage comment for `aiu` to `table, recommendation and burn plan of all accounts`.**

- [ ] **Step 4: Run the whole suite and check the real output**

Run: `npm test && npm run typecheck && node src/cli.ts`
Expected: tests pass; real output ends with a `Plan` section whose first Claude row is the account `Recommendation` names.

- [ ] **Step 5: Commit**

```bash
git add src/render.ts src/cli.ts README.md tests/render.test.ts tests/cli.test.ts
git commit -m "Print the burn plan under the recommendation"
```
