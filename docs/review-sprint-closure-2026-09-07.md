# Sprint 3–5 closure checks — 2026-09-07

This record follows the findings in [the integration review](review-sprints-3-5-2026-09-07.md).
The work uses local fixtures, temporary SQLite databases, and mocked model and Telegram transports.
No paid model call, live workout write, deployment, or production database change ran during this work.

## Sprint 3

| Finding | Change and verification |
| --- | --- |
| S3-01 | A controlled scheduler verifies disabled polling, completion timing, backoff, recovery, timer cancellation, and shutdown during a scan. |
| S3-02 | Tests cover the ten-record cutoff, date edits, refill failure, checkpoint-write failure, and reopening SQLite. Both data and checkpoint survive failure. |
| S3-03 | Dates use numeric timestamps. The first scan after restart and an hourly scan rebuild the latest ten records. Invalid dates fail without advancing state. |

The [official Hevy API schema](https://api.hevyapp.com/docs/swagger-ui-init.js) states that workout events arrive newest first.
The schema does not specify an event-retention period. This review checked the schema on 2026-09-07.
Hourly rebuilding is an application recovery policy. It is not evidence of a particular Hevy retention period.
A missed event can remain undetected until reconciliation. Sleep, network failure, or disabled polling can delay reconciliation.

The full scan replaces a scheduled incremental scan. It does not run a second timer.
The cache still holds ten workouts. No migration framework or additional store was added.
Independent review approved the synchronization changes and ten focused tests.

## Sprint 4

| Finding | Change and verification |
| --- | --- |
| S4-01 | Explicit refresh bypasses snapshots and runs in order. Tests cover later reads, repeated refreshes, and failed workout and routine refreshes. |
| S4-02 | Cached and remote workout reads use the same count validator. Tests cover defaults, zero, fractions, excessive counts, and invalid types. |
| S4-03 | Successful routine mutations invalidate routine context. Failed and blocked writes preserve it. Note and max changes rebuild the volatile suffix. |
| S4-04 | Automatic excerpts cap workout content at 6,000 bytes and routine content at 3,000 bytes. Tests preserve UTF-8 and full tool access. |

The first independent review exposed a masked deadline error. A timer could reject before the later wall-clock comparison detected expiry.
The function now propagates settled deadline errors directly. A deterministic test covers a deadline error with a future clock deadline.

The existing normal fixture produces 752 bytes of prepared context. It includes a standing routine and no completed workouts.
A synthetic 200,000-byte multilingual excerpt reduces to 6,039 bytes, including section markers.
The test reports rough character-based token estimates separately. Those estimates are neither provider token counts nor billed usage.
These checks establish bounded excerpts. They do not establish production cost savings or the size of the complete prompt.

A slow context check can still consume the shared turn budget. The implementation retains that deadline instead of inventing a shorter timing target.
Normal-use observations will determine whether a separate context budget is useful.

## Sprint 5

| Finding | Change and verification |
| --- | --- |
| S5-01 | The same queue contains coaching, delivery, and failure handling. Real chunk delivery tests reconstruct two long replies and verify no interleaving. |
| S5-02 | Sends use an abort signal and the earlier of the turn deadline or 30 seconds. Retry waits share that limit. Tests cover stalled and expired sends. |
| S5-03 | A distinct five-second notice reports confirmed delivery and possible saved changes. Tests cover successful coaching followed by partial delivery failure. |
| S5-04 | Transport and top-level handlers log selected safe fields. Tests reject nested message and credential content in serialized log fields. |

The installed Telegraf client forwards the abort signal to its HTTP transport.
Cancellation cannot prove that Telegram did not accept a message. Unknown outcomes do not trigger resends.
An expired queued turn receives an ordered notice through a new queue slot. A regression test covers that path.

The first delivery review requested two additional handler tests. Both now cover actual multiple-chunk delivery and the expired-turn notice path.

## Release limits

Production verification remains deferred. No restart or remote CI result is claimed.
Normal use must verify operational behavior before release closure. No additional paid test campaign is authorized.
Streaming, cache retention changes, and hosting changes remain conditional.

## Final local gate

Both TypeScript checks, all 90 tests, and the whitespace check passed.
The independent reviewer verified the deadline fix and both additional delivery tests.
No blocking finding remains from S3-01 through S5-04. Sprints 3–5 pass their local gates.
Production verification remains open.
