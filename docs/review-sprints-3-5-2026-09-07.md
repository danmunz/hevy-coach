# Review of sprints 3–5 — 2026-09-07

Scope: current code at `ad2393c`, local tests, and the refreshed performance plan.
This review supersedes the earlier statement that no blocking integration defects remain.
The existing components work in covered cases. Several cross-component paths still need changes or verification.

Both TypeScript checks and all 59 tests passed during this review. The whitespace check passed.
No live API calls, paid model calls, deployment, or database changes ran during this review.
Source inspection supports the findings below. Passing tests do not cover every finding.

## Sprint 3 — Workout freshness

The code stores workouts and the checkpoint in one transaction. It shares active scans and overlaps checkpoints by 60 seconds.
Tests cover duplicate updates, cached deletion, failed scans, concurrent foreground checks, and fractional weights.

| ID | Severity and evidence | Remaining work |
| --- | --- | --- |
| S3-01 | Medium, missing coverage. `tests/workout-sync.test.ts` has no scheduler tests. | Verify disabled polling, completion-based scheduling, failure backoff, recovery, and stop during an active scan. Use a controlled clock. |
| S3-02 | High verification priority, missing coverage. The changed-date refill branch has no direct regression. Cache rollback lacks an injected storage failure test. | Test more than ten records, date edits across the cutoff, deletion/refill failure, restart recovery, and a failed transaction. Compare both payloads and checkpoint. |
| S3-03 | Medium, unresolved assumption. `WorkoutSync.scan()` takes the first event for each ID and sorts date strings. | Record evidence for event order and retention. Normalize timestamps or compare numeric dates. Test equivalent times with different offsets. Define recovery when the checkpoint exceeds supported retention. |

S3-03 does not establish that Hevy currently returns incorrect ordering. It identifies an external contract that the local fixtures assume.
A 60-second overlap does not prove recovery from every pagination shift or long outage.
Prefer a bounded latest-ten rebuild when incremental recovery cannot be trusted. Do not add a second event store.

## Sprint 4 — Coaching context

Tests verify the static cache boundary, freshness failure text, bounded waits, checked-read reuse, and routine context invalidation.

| ID | Severity and evidence | Remaining work |
| --- | --- | --- |
| S4-01 | High, confirmed control-flow defect. `src/claude/client.ts` always serves `freshWorkouts` when present. Checked routine lists also lack an explicit refresh bypass. | Add explicit refresh semantics. A requested refresh must perform a new read and replace the relevant snapshot. Test a remote change between model iterations. |
| S4-02 | Medium, confirmed inconsistency. The cached workout path clamps counts. The live client rejects invalid counts. | Validate inputs before either path. Test zero, fractions, values above ten, and default count. Require identical results or errors. |
| S4-03 | Medium, confirmed excess invalidation. Every non-read tool removes checked context before its outcome is known. | Invalidate only affected data after a successful mutation. A saved note must not discard routine data. Failed or blocked writes must preserve valid snapshots. |
| S4-04 | Medium, unmeasured cost risk. `prepareFreshContext()` injects ten complete workout summaries and routine data on every turn. Notes have no size bound. | Measure representative and large fixture payloads offline. Bound automatic context and report omitted coverage. Keep complete data available through tools. |

S4-01 contradicts the prompt instruction to call the workout tool when data needs a refresh.
S4-04 can increase input cost despite fewer reads. Current tests establish neither the size increase nor a net cost saving.
The remaining turn time bounds freshness waits. It does not reserve time for the model after a slow routine check.
Measure this behavior with delayed fixtures before deciding whether a shorter context deadline is necessary.

## Sprint 5 — Telegram delivery

Tests cover balanced chunks, entities, Unicode, formatting fallback, explicit rate limits, uncertain sends, and observer failures.

| ID | Severity and evidence | Remaining work |
| --- | --- | --- |
| S5-01 | High, integration ordering risk. `src/index.ts` releases the turn queue before sending the answer. | Preserve response order across turns. Test a delayed first response and a fast second response. Their chunks must not interleave. |
| S5-02 | High, confirmed deadline gap. `sendSplitMessages()` bounds retry waits but has no overall delivery deadline. | Bound sends and the complete delivery operation. The installed Telegraf client uses a 500,000 ms request timeout. An uncertain timeout must not trigger a resend. |
| S5-03 | Medium, confirmed error-path gap. The handler ignores `DeliveryError.deliveredChunks` and gives a generic retry instruction. | Distinguish coaching failure from partial or uncertain delivery. Do not imply that a successful Hevy write failed. Test successful mutation followed by failed delivery. |
| S5-04 | Medium, confirmed logging risk. The handler logs complete error objects, including nested delivery causes. | Log selected safe fields. Telegraf errors can contain request payloads. Verify that message text and credentials do not enter logs. |

S5-01 is a source-level race opportunity, not a reported production incident.
S5-04 reopens the log-content requirement from sprint 1 at the transport boundary. It does not require rebuilding telemetry.
Do not solve S5-01 by holding an unbounded delivery operation inside the coaching queue.
A timeout only ends local waiting unless the transport also supports cancellation. Treat unresolved sends as uncertain.

## Review decision

Sprints 3–5 remain implemented but open. Close the local gaps before declaring these sprints complete.
Production verification can remain deferred until the combined release is ready.
Streaming, longer cache retention, and hosting changes remain conditional.
