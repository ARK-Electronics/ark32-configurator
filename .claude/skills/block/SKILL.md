---
name: block
description: Work one block of the ARK32 configurator overhaul (issue #3) end to end, from cold context to merged PR.
disable-model-invocation: true
---

Work **one** block of the overhaul plan: $ARGUMENTS

Do not start the next block. When this block is done, stop and report.

## 1. Orient

```bash
cat docs/plans/overhaul/STATUS.json
git log --oneline -15
yarn verify          # must be green before you change anything
```

Then read the block from issue #3:

```bash
gh issue view 3 --repo ARK-Electronics/ark32-configurator
```

If `yarn verify` is red on a clean tree, stop and report that instead — a
previous block left master broken and that is the real task.

## 2. Verify the plan before trusting it

The audit's file:line references were written against commit `4094dad`. Earlier
blocks move code. **Re-check every line reference your block depends on** before
acting on it, and say in your report if one has drifted.

Protocol claims are settled by reading firmware, not by reasoning about it. The
sources are local — see the list in `CLAUDE.md`. **Read them with a subagent**,
not in your main context: they are large, you need one answer from each, and
filling context with C source is the fastest way to lose the plot halfway
through a block.

## 3. Plan

Stay in plan mode until you have a plan for this block only. Name the files you
will touch, the tests you will write, and what you are explicitly not doing.

## 4. Implement

- **Write the failing test first.** For blocks with a fault-injection row in the
  plan, that row is the test. A fix with no test that would have caught it is
  not done.
- Never weaken, skip or delete a test to make a block pass. If a test is wrong,
  say so explicitly and explain why in the PR.
- Protocol logic goes in `packages/am32-core`. If you find yourself wanting
  `navigator`, `window`, `Buffer` or `process` there, the code belongs in a
  transport package instead — the tsconfig will stop you either way.
- Commit incrementally with real messages. `type(scope): subject`.

## 5. Verify, with evidence

```bash
yarn verify
```

Run the block's own done-when command too. **Paste the actual output into your
report.** "The tests pass" is not evidence; the test output is. If you skipped
part of the block, say which part and why — do not quietly narrow the scope.

## 6. Get a second opinion

Use a subagent to review the diff against this block's done-when in a fresh
context:

> Review this diff against block N of issue #3. Check that every stated
> requirement is implemented, that the fault-injection cases have tests, and
> that nothing outside the block's scope changed. Report only gaps that affect
> correctness or the stated requirements — not style preferences.

Fix real gaps. A reviewer asked for gaps will usually find some; do not chase
findings into over-engineering.

## 7. Land

Blocks land on `master` directly — no PRs. Commit locally with real messages and
push to `ark`, never `origin` (that is upstream `am32-firmware`):

```bash
git push ark master
```

`master` must be working when you leave it: `yarn verify` green and the app still
connects.

Then update `docs/plans/overhaul/STATUS.json`: set this block's `status`, fill
in `landedIn`, and record anything the next block's agent would otherwise have
to rediscover.

> Running under `scripts/overhaul-loop.sh`? The driver owns git and `STATUS.json`
> — commit your work, but do not push and do not edit `STATUS.json` yourself.

## 8. Stop

Report what landed, what the verification output was, and what the next block
should know. Do not begin it.
