# Implementation Review — 2026-09-07

## Scope

Performance and reliability implementation following
`docs/review-performance-2026-09-06.md`:

- direct Hevy exercise-history retrieval;
- complete workout-set summaries and compact routine set input;
- upgraded Anthropic SDK, turn queue, progress indication, and end-to-end deadline;
- scratch-state CLI mode;
- idempotency protection, stale-routine detection, and recovery for Hevy writes.

## Findings and resolution

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| IMP-001 | High | A rejected rate-limited write could retain the pending-mutation block. | Classify 429 responses as definitive Hevy API rejections and clear the pending state; create and update regressions cover it. |
| IMP-002 | High | Runtime-resolved exercise IDs were only in memory, preventing later remote comparisons and recovery. | Store resolved IDs in pending state and persist them with the confirmed routine cache in one SQLite transaction. |
| IMP-003 | High | A retry backoff could outlive a 75-second active turn deadline. | Retry waits now fail before waiting when the remaining deadline is shorter than the delay. |
| IMP-004 | Medium | A remote routine edit could be overwritten without a current-state check. | Compare a normalized remote routine snapshot with the last confirmed local snapshot; require an explicit user-confirmed override on a mismatch. |
| IMP-005 | Medium | The test CLI used production state as read context. | Create a SQLite backup in a temporary directory before application imports and delete it when the CLI exits; live Hevy routine writes remain blocked. |

## Verification

Ran on 2026-09-07:

```text
npm run typecheck
npm test
git diff --check
```

All checks passed: strict TypeScript compilation and 20 focused tests. A live
read-only CLI smoke turn also completed successfully with `claude-sonnet-5`
through `@anthropic-ai/sdk` 0.124.0; it took 2.4 seconds, made no tool calls,
and wrote only to the temporary CLI database.
