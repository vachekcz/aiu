# Usage plan — Design

Date: 2026-11-19
Status: draft, awaiting approval

## Intent

Pavel pays for several subscriptions and wants none of their capacity to lapse
unused. Today `aiu` names one account to use now, but not the order to work
through the rest, and it ranks by "% per hour needed", which can let a small
pot lapse (see Approaches). The goal is a plan below the existing output that
says which account to burn until when, and with which model.

## Goals

- Nothing lapses: the account whose capacity lapses first is used first.
- Premium model first, but only where that costs nothing: on the account the
  plan picks, use its model-specific limit (Claude Fable) while it has room.
  A premium limit on another account waits its turn; it never jumps ahead of
  capacity that lapses sooner.
- `Recommendation` and the plan always name the same account.

## Non-goals

- Changing the table or the `Model limits` section.
- Modelling how much of a weekly limit one 5h window covers. The plan says
  `burn 43 %` even if that does not fit before the reset.
- Separate `aiu pace` (view B) and the ranking table (view A). Considered, not
  wanted now.

## Approaches

Ordering (Pavel chose deadline):

- **Earliest deadline first (chosen).** Sort usable accounts by their weekly
  reset. If everything can be burned in time, this order loses nothing.
- **% per hour needed (today).** Ranks by weekly % left / hours to reset. It
  shows effort, but it can let a pot lapse: X has 5 % left for 2h, Y 60 % for
  10h; Y ranks first and X's 5 % lapses, while deadline order burns X in an
  hour and still leaves 9h for Y.

Views: A (ranking table), B (pace bars), C (plan). Pavel picked C, printed
under today's output.

## Design

Default `aiu` output: table, then `Recommendation` (its per-provider `use …`
line now follows the plan's first row), `Model limits`, then a new `Plan`:

```
Plan
  Claude   now → Thu 16:00   vachek@dotidot.io          burn 43 %
                → Fri 19:00   pvachek@fakturaonline.cz   burn 27 %
                → Mon 21:00   info@fakturaonline.cz      burn 26 %
           Fable back Thu 16:00 dotidot · Fri 19:00 pvachek · Mon 21:00 info
  ChatGPT  nothing usable · back Fri 21:19 on ja@pvachek.cz
```

When a planned account has its premium limit free, its row ends with
`with Fable first` (the label of its `kind: 'model'` limit).

Rules:

- Per provider, plan rows are the usable accounts (same usability test as
  today: no used-up 5h or weekly limit) that have a weekly limit with % left,
  sorted by weekly `resetsAt`; unknown reset sorts last. Accounts without a
  weekly limit are left out of the plan.
- An account blocked only by its 5h window is still in the plan (its weekly
  capacity still lapses); its row says when the 5h window frees up. Builder's
  call on the exact wording.
- `Recommendation`'s `use …` = the first plan row whose 5h window has at least
  `SESSION_ROOM` % left; if none has, the first plan row.
- "Back" line: premium limits used up on some accounts, with their resets.
- `--json` gets `recommendation.plan` with the same rows.

## Left to the builder

- Where the plan logic lives (`recommend.ts` is the natural home) and how
  `Advice` grows.
- Column alignment and colour, matching the existing sections.
- Tests for: deadline order, premium-first marker, the 5h-blocked row, the
  `Recommendation` line matching the plan, unknown resets, JSON shape.
