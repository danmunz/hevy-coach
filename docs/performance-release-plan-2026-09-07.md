# Refreshed performance plan — 2026-09-07

This revision follows the [sprint 3–5 review](review-sprints-3-5-2026-09-07.md).
It separates implemented features, verified behavior, and open release gates.
No further paid model tests are authorized. Production effort remains `high`.

## Current status

| Sprint | Status | Remaining gate |
| --- | --- | --- |
| 1. Measurement and storage | Implemented and locally verified. | S5-04 is closed. Verify remote CI at release. |
| 2. Hevy reads | Implemented and locally verified. | Equipment choices are resolved. No separate open implementation task. |
| 3. Workout freshness | Local gate passed. | Observe recovery during normal use. |
| 4. Coaching context | Local gate passed. | Measure actual context cost and timing during normal use. |
| 5. Telegram delivery | Local gate passed. | Verify the deployed transport during normal use. |
| 6. Production verification | Deferred until the combined release is ready. | Restart, verify CI, and observe normal use. |

The [closure record](review-sprint-closure-2026-09-07.md) documents the fixes, independent reviews, and local verification.
All 90 local tests and both TypeScript checks pass.
Production verification remains open. No production speed improvement is established.

## Sprint 3 — Local gate passed

S3-01 through S3-03 are closed locally.
Controlled tests cover scheduling, failures, restart recovery, and the latest-ten boundary.
Dates use numeric timestamps. Failed refill and checkpoint writes preserve the previous cache.
The bot rebuilds the latest ten on startup and at least hourly when scans run successfully.

Hevy documents event order but not retention. Hourly rebuilding is a recovery policy, not an immediate-freshness guarantee.
The implementation retains one process, one timer, and the existing SQLite store.

## Sprint 4 — Local gate passed

S4-01 through S4-04 are closed locally.
Explicit refresh performs a new read. A failed refresh removes the old current-data claim.
Cached and remote reads validate counts consistently. Successful mutations invalidate only affected data.
Local note and training-max changes rebuild the volatile prompt suffix.

Automatic workout content is limited to 6,000 bytes. Routine content is limited to 3,000 bytes.
Incomplete excerpts state their limits. Tools provide complete workout summaries and routine sets.
Byte limits do not establish token counts or cost savings. The full prompt still includes history and local state.
The shared deadline remains in force. A delayed context check can consume that budget.

## Sprint 5 — Local gate passed

S5-01 through S5-04 are closed locally.
The existing queue now includes bounded delivery. Tests verify multiple chunks across two replies without interleaving.
The answer uses the earlier of its remaining turn deadline and 30 seconds. A distinct failure notice has five extra seconds.
Unknown delivery outcomes never trigger automatic resends. Error logs exclude nested request payloads.

Cancellation cannot retract a message already accepted by Telegram. Delivery notices distinguish confirmed parts from uncertain outcomes.
The implementation adds no persistent outbox, queue service, or resend command.

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

Sprints 3–5 passed their local gates. The combined release is ready for the deferred production check.
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
