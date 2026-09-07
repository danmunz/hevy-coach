# Freshness and delivery review — 2026-09-07

Scope: workout synchronization, checked context, Hevy reads, chat storage, telemetry, CI, and Telegram delivery.
The implementation engineer and independent reviewers examined the changes. Tests use temporary databases and mocked transports.

| ID | Severity | Finding | Fix and verification |
| --- | --- | --- | --- |
| FRESH-001 | High | A foreground turn could accept an older background scan. | Require a scan start after context preparation begins. A concurrent-scan test verifies the second check. |
| FRESH-002 | High | Partial pagination could advance the workout checkpoint. | Reject malformed pages and incomplete scans. Tests preserve the previous checkpoint after failure. |
| FRESH-003 | High | A routine request or shared scan could exceed the turn deadline. | Bound both waits. Separate tests cover each stalled request. |
| FRESH-004 | Medium | Cached workout weights could round fractional pounds. | Store exact converted pounds and restore API precision. A fractional-weight test verifies the conversion. |
| FRESH-005 | High | A changed workout date could leave the latest-ten cache incomplete. | Fetch the latest ten again when a cached date changes or a cached workout is deleted. |
| FRESH-006 | Medium | Routine context could survive a mutation. | Invalidate the checked routine list and prompt context at the mutation barrier. |
| SEND-001 | High | A delivery observer exception could alter send behavior. | Isolate observer exceptions. Tests verify delivery and the original send error. |
| PIN-001 | High | Broad matching could select the wrong equipment. | Require a unique exact or word-order match. Read-only verification identified existing equipment conflicts. |

The reviewer found no remaining blocking code defect in the integration before the final test pass.
The saved Dips and Seated Row mappings still need a user choice. The implementation does not alter those database rows.

Both TypeScript checks, all 59 local tests, and the whitespace check passed.
CI repeats the TypeScript checks and local tests.

No paid Claude call ran during this work. Read-only Hevy checks verified template names and exercise IDs.
The usual live coaching smoke test remains part of normal use. It did not run as a funded test.
These checks establish local correctness. They do not establish a measured production speed improvement.
