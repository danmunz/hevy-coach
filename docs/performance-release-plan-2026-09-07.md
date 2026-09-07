# Remaining performance work — 2026-09-07

This document tracks the refreshed release. Local verification does not establish a measured improvement in production speed.
No further paid model tests are authorized. The production effort remains `high`. Streaming remains conditional.

| Stage | Implementation | Validation and next gate |
| --- | --- | --- |
| 1. Measurement and storage | Record turn, model, HTTP, tool, queue, context, and delivery events. Store each chat pair in one transaction. Add CI. | Both TypeScript checks and local tests must pass. Logs must exclude credentials and message bodies. |
| 2. Hevy reads | Reject uncertain exercise matches. Refresh template cache after a miss. Share identical reads within a read batch. | Test ambiguous names, failed refresh, pagination, and read reuse. Resolve equipment conflicts before changing affected exercise mappings. |
| 3. Workout freshness | Store ten latest workouts and a checkpoint in SQLite. Apply events atomically. Check every turn and every five minutes. | Test changes, deletions, partial failures, repeated events, concurrent scans, and deadlines. Failed scans must preserve the previous checkpoint. |
| 4. Coaching context | Check workouts and the standing routine before coaching. Reuse checked data. Keep variable data below the cache boundary. | Test the prompt boundary, pound conversion, unavailable freshness, and context invalidation after mutations. |
| 5. Telegram delivery | Balance HTML chunks. Remove fixed pauses. Restrict fallback and retries to explicit rejections. | Test Unicode, entities, formatting errors, rate limits, partial delivery, and uncertain sends. |
| 6. Normal use | Restart the bot with the approved release. Observe normal conversations. | Compare queue, context, model, and delivery times. Check freshness, cache reads, and user-visible failures. Do not start a paid test campaign. |

The implementation engineer owns code changes. The reviewer checks correctness before commits.
The test writer uses fixtures and a mocked model transport. The quality reviewer checks each stage before progression.
Documentation must identify remaining limits. A passing local test does not close the normal-use gate.

## Freshness decisions

The implementation uses one timer in the existing process. It needs no separate cron service or database framework.
The default interval is 300 seconds. A 30-second interval would schedule 2,880 checks daily before pagination and retries.
The default schedules about 288 daily checks. Foreground checks add requests when the user sends a message.
Actual counts depend on scan duration, sleep, failures, and jitter.

A foreground request requires a scan that started after context preparation began.
The checkpoint records scan start time. Each later request overlaps the previous checkpoint by 60 seconds.
A failed or incomplete scan cannot advance the checkpoint. A deletion or changed workout date can require a fresh latest-ten scan.

Background synchronization calls Hevy only. It does not call Claude or send a message.
It cannot run while the laptop sleeps. The next scan catches changes after the laptop wakes.

The local cache replaces a separate text log. It stores structured workout data and pounds.
This avoids parsing another file and keeps data and checkpoint changes atomic.

A future webhook can request the same synchronization function if Hevy provides a supported change notification.
This release does not depend on an unverified webhook service. Polling and foreground checks supply the current mechanism.

## Remaining decisions and gates

- Confirm the intended Dips and Seated Row variants. Existing IDs identify Ring Dips and Seated Row (Machine).
- The equipment file lists neither rings nor machines. Do not replace those mappings without an explicit choice.
- Restart and observe the release during normal use. No production latency result is available from local tests.
- Consider streaming only if model wait still dominates and partial output has clear value.
- Consider longer prompt-cache retention only after normal-use cache measurements support the additional cost.
- Consider hosting changes only if laptop sleep causes missed availability that matters to the user.

The previous effort decision retained `high`. It did not prove that `high` gives better answers than `medium`.
The final budgeted campaign cost $2.079006. Medium passed 20 cases. High had six failures caused by output limits.
No new paid campaign is part of this release.
