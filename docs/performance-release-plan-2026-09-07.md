# Refreshed performance plan — 2026-09-07

This revision follows the [sprint 3–5 review](review-sprints-3-5-2026-09-07.md).
It separates implemented features, verified behavior, and open release gates.
No further paid model tests are authorized. Production effort remains `high`.

## Current status

| Sprint | Status | Remaining gate |
| --- | --- | --- |
| 1. Measurement and storage | Implemented and locally verified. | Correct transport error logging under S5-04. Verify remote CI at release. |
| 2. Hevy reads | Implemented and locally verified. | Equipment choices are resolved. No separate open implementation task. |
| 3. Workout freshness | Implemented. Local gate open. | Verify scheduler, cache recovery, and event assumptions. |
| 4. Coaching context | Implemented. Local gate open. | Fix explicit refresh, input validation, and excess invalidation. Bound automatic context. |
| 5. Telegram delivery | Implemented. Local gate open. | Fix ordering, delivery deadlines, failure reporting, and error logs. |
| 6. Production verification | Deferred until the combined release is ready. | Restart, verify CI, and observe normal use. |

The current 59 tests pass. Both TypeScript checks pass. These results do not close the new review findings.
No production speed improvement is established.

## Sprint 3 — Complete freshness verification

Address S3-01 through S3-03 before closing this sprint.

1. Add deterministic scheduler tests for disabled polling, backoff, recovery, and shutdown.
2. Test the latest-ten boundary with inserted, edited, and deleted workouts.
3. Inject a refill failure and a storage failure. Verify unchanged data and checkpoint.
4. Restart against the temporary database. Verify recovery without lost changes.
5. Check the Hevy event contract for order and retention. Record the source and any uncertainty.
6. Compare parsed timestamps. Define a bounded full refresh when incremental recovery is uncertain.

Keep the existing single-process timer and SQLite cache. Use temporary databases and mocked Hevy responses for regression tests.
Do not add a separate cron service, text log, queue service, or database framework.

**Exit gate:** Every S3 finding has a passing check or an explicit, tested recovery rule.
Record the results in the review document. The reviewer must confirm that failed scans cannot advance the checkpoint.

## Sprint 4 — Correct context reuse

Address S4-01 through S4-04 after the freshness contract is stable.

1. Add an explicit refresh option to relevant read tools. Preserve existing default calls.
2. Replace a snapshot after a successful refresh. Mark a failed refresh as unavailable without calling old data current.
3. Validate workout counts before choosing the cache or live path.
4. Invalidate affected data after successful mutations. Preserve unrelated checked data.
5. Test refresh across model iterations and successful, failed, and blocked mutations.
6. Measure context size with normal and large local fixtures, including long notes.
7. Bound automatically inserted context. State the included coverage and provide tools for omitted details.
8. Test delayed context requests against the shared turn deadline.

Use the real chat loop with a mocked model transport. Do not buy model evaluations or use live coaching for these tests.
Keep static instructions above the prompt-cache boundary. Keep config files responsive to edits on the next message.

**Exit gate:** Explicit refresh performs a new read. Cached and live inputs have the same validation.
Tests must show correct mutation behavior, bounded automatic context, and a stable static prefix.
Record bytes and estimated tokens separately. Do not present an estimate as billed usage.

## Sprint 5 — Complete delivery integration

Address S5-01 through S5-04 after the context contract is stable.

1. Define delivery ordering and timeout behavior together.
2. Prefer the existing turn queue through bounded delivery if this preserves the message deadline contract.
3. Use a small ordered delivery queue only if tests show that the simpler approach blocks coaching unnecessarily.
4. Bound the complete delivery operation and its network calls. Preserve uncertainty when cancellation cannot confirm non-delivery.
5. Handle partial and uncertain delivery separately from coaching failure.
6. Replace complete error logging with selected safe fields.
7. Test two rapid user turns, a stalled send, retry exhaustion, partial delivery, and a successful write followed by delivery failure.
8. Verify text preservation and chunk order through the handler, using mocked Telegram calls.

Document the selected delivery deadline before implementation. Include retry waits in that deadline.
Never retry an uncertain send automatically. Do not add a persistent outbox or resend command for this sprint.

**Exit gate:** Replies do not interleave. A stalled send cannot block later work indefinitely.
Failure notices must reflect confirmed outcomes. Logs must exclude message bodies and credentials.
The reviewer must verify these cases at the handler boundary, not only in the chunk helper.

## Ownership and documentation

Use the Scrum Team implementation engineer for fixes and the test writer for deterministic regressions.
Use the code reviewer for independent review and the quality-gate manager for sprint closure.
Use the architecture reviewer only if queue or timeout choices remain in conflict.
Use the ASD-STE100 skill for documentation and reports.

Each sprint produces atomic commits, updated regression tests, and a review record with finding IDs.
Update the README when settings, run procedures, or user-visible failure behavior change.
Run both TypeScript checks, affected tests, and the whitespace check before commits.
Run the complete suite before each sprint closes. A passing test count alone does not close a finding.

## Deferred production gate

Complete sprints 3–5 locally before restarting the combined release.
Verify the remote CI result. Record the deployed revision and the previous revision for rollback.
Back up SQLite before deployment. Preserve pending mutation records during any recovery.

Observe normal conversations without a separate paid test campaign.
Check startup, fresh workout visibility, prompt-cache reads, reply ordering, and failures.
Compare queue, context, model, and delivery times for similar requests.
Do not force live workout writes or deletions merely to generate test coverage.

If no comparable baseline exists, report operational timing only. Do not claim a percentage improvement.
Keep production verification open until the observation record supports its claims.
A wrong exercise, incorrect freshness claim, duplicate write, or uncertain delivery requires investigation before release closure.

## Decisions retained

- Polling runs in the existing process every 300 seconds, plus scan duration and jitter.
- Setting `HEVY_SYNC_INTERVAL_SECONDS=0` disables background polling. Foreground checks remain enabled.
- A separate webhook remains conditional on a supported Hevy notification mechanism.
- Both bar-grip and triangle-grip cable rows are available. Dips are unavailable.
- Streaming remains conditional on observed model wait and the value of partial output.
- Longer cache retention remains conditional on normal-use cache measurements and cost.
- Hosting changes remain conditional on laptop sleep causing material availability problems.

The final effort campaign cost $2.079006. Medium passed 20 cases. High had six failures caused by output limits.
Retaining `high` did not establish that it gives better answers than `medium`. No further paid campaign is planned.
