# Performance audit: Hevy Coach

Date: September 6, 2026 (America/New_York)

Scope: current source, configuration, scripts, dependencies, runtime settings, local log samples, read-only database statistics, prior reviews, and remote issues.

Revision: `08f49e79fd2eae59cd9f5c20352c737b81388d39` on `main`; matches the latest remote commit returned during this audit.

## Assessment

The biggest opportunities are reducing unnecessary model generation and model round trips, followed by making data retrieval reusable. Local computation is already negligible at this scale. Preserve the single-process design, SQLite, raw HTTP client, and config hot-reload.

My recommended first performance release combines compact routine inputs, reliable exercise resolution, and use of Hevy's dedicated exercise-history endpoint. Establish isolated verification and complete timing first. Next, evaluate Sonnet 5 at lower effort. Preloading fresh coaching context could remove an entire model call, but needs more care because stale workout state can lead to the wrong program or an overwritten routine.

Do not assume every shorter response is an improvement. Current workout summaries already discard evidence the coaching instructions ask the model to use. Reducing reasoning or context without fixing that would make the bot cheaper while potentially making its coaching less reliable.

Only this report was added. No application code, configuration, production database contents, Hevy routines, or remote issues were changed. No live coaching messages or paid model-generation benchmarks were run.

## Evidence and limits

| Evidence | Finding | Interpretation |
| --- | --- | --- |
| Local context microbenchmark, 100 warm samples | Median **0.52 ms**, p95 **0.57 ms** for config reads, corresponding SQLite reads, and date formatting | Approximation of assembly work, not an end-to-end benchmark; disk/DB micro-optimization has almost no current payoff |
| Read-only SQLite inspection | 44 stored messages; current 30-message window contains 7,779 characters; 18 exercise mappings; no active notes | History needs growth controls, but is not currently an enormous context; characters are not tokens |
| Mocked concurrent history calls on one `HevyClient` | Two exercise histories made **10 requests for 5 unique pages** | Existing tool parallelism does not deduplicate the shared underlying data |
| Live read-only Hevy comparison | General scan: **5 requests / 50 workouts / 648 ms**; dedicated history: **1 request / 178 ms**; set counts agreed for 19 matching workouts / 78 sets | One exercise and one sequential sample: 80% fewer requests and 470 ms less elapsed time here, not a general latency guarantee or full field-parity proof |
| Compaction of first routine payload in local logs | 14 physical sets → 8 group entries; JSON **825 → 491 characters**, a **40.5% reduction** | Real payload shape; offline transformation, not a measured model-token or latency reduction |
| Synthetic summary comparison | One set and three sets, including a lower-rep set, produced identical workout summaries | Current compression loses volume and evidence of missed reps |
| Mocked routine creation after ambiguous network failure | Client issued POST twice | Confirmed retry behavior; duplicate remote creation is a risk, not a claimed production incident |
| Type check | `npx tsc --noEmit` passed | Covers `src/`; current tsconfig excludes scripts; no automated test suite or CI found |

The local logs predate the new per-call timing/usage format: they contain call starts but no `cache_w`, `cache_r`, `out`, or `ms` records. They cannot prove the currently running process has loaded the latest code, and gaps between user turns are not response-duration measurements.

There is stronger historical evidence in [issue #14's measurement comment](https://github.com/danmunz/hevy-coach/issues/14#issuecomment-5556528539): a two-call turn used 1.943 s and 9.212 s of model time, with a **6,129-token cached prefix**. This supersedes the ~4,400-token estimate still repeated in source comments and AGENTS.md. These are reported prior measurements, not a fresh benchmark performed here. The approximately 49-second slow turn mentioned in issues is useful background, not a defensible current p95.

Already implemented and worth preserving: module-level clients; caching of the static prompt and tools; template caching with in-flight sharing and reset on failure; concurrent consecutive read tools with ordered write barriers; compact workout summaries; a targeted routine-edit tool; bounded history by age/count; and truncation detection. [Closed issue #12](https://github.com/danmunz/hevy-coach/issues/12) and merged #15 should not be counted as wholly outstanding work.

## Ranked opportunities

Severity describes the impact of the finding; priority describes when to act. Estimated gains below are hypotheses for affected turns and must not be added together.

| ID / priority | Opportunity | Likely speed and cost effect | Quality or operational tradeoff |
| --- | --- | --- | --- |
| PERF-001 / P0 | Isolated evaluation and complete telemetry | No direct speed gain; prevents optimizing the wrong component | Small implementation cost; protects real memory and routines |
| PERF-002 / P1 | Fix resolution failures and validate routine inputs | Removes an entire repair-generation step when a name fails; local log shows an approximately 8-second interval before a replacement payload | Better correctness; avoid aggressive fuzzy matching that silently changes equipment or exercise |
| PERF-003 / P1 | Compact repeated sets, #13 | Measured 40.5% JSON-character reduction on one logged payload; several seconds is plausible on generation-heavy pushes | Requires strict expansion tests; total output includes thinking and prose, so total savings will be smaller |
| PERF-004 / P1 | Dedicated exercise-history endpoint, then shared repeated reads | Live sample reduced five requests to one; two distinct histories can use two requests instead of ten | Verify date coverage, set normalization, and grouping; cross-turn caching needs freshness controls |
| PERF-005 / P1 | Improve workout evidence before reducing reasoning | Slightly more input, potentially fewer follow-up queries and wrong plans | Deliberately spends some tokens to preserve training quality |
| PERF-006 / P2 | Upgrade SDK, evaluate explicit effort, #14 | Potentially the largest broad reduction in generation time and output cost; magnitude unmeasured | Lower effort may miss constraints, program ambiguity, or approvals |
| PERF-007 / P2 | Supply fresh routine/workout context before the first model call, revise #4 | Removes one model round trip on eligible turns; historical initial call alone was 1.943 s | Extra reads on irrelevant chat and stale-state risk if applied indiscriminately |
| PERF-008 / P2 | Tune cache TTL and bound growing context | Material input-cost savings in the right usage pattern; variable latency improvement | Longer TTL can cost more; trimming can lose pending plans and constraints |
| PERF-009 / P1–P2 | End-to-end deadlines, write reconciliation, turn serialization | Limits long stalls and duplicate work; does not accelerate successful model inference | Too-short deadlines increase incomplete turns; queued messages wait behind active work |
| PERF-010 / P1 small UX change | Progress signals and delivery fixes, #17 | Earlier acknowledgment; removes avoidable delivery failures and selected pacing delays | Progress is perceived responsiveness, not reduced inference cost |

### PERF-001 — Build a trustworthy baseline and evaluation seam

**Severity: medium.** [Issue #16](https://github.com/danmunz/hevy-coach/issues/16) is a prerequisite for reliable performance experiments. `scripts/chat.ts` calls the same `chat()` function and database as Telegram. A `persist: false` flag alone would leave note/TM mutations and real Hevy writes enabled, and would lose multi-turn scratch memory unless separately retained.

Use a scratch SQLite snapshot for CLI evaluation, preserving the starting coaching state, then record subsequent turns in that scratch session. Default Hevy writes to a validating mock or preview transport. Live-read evaluation can remain available. Make any live-write test mode explicit. A configurable DB path and a narrow dependency/options seam around `chat()` are sufficient; no general plugin framework is needed.

Add a turn ID and events for receipt, queue wait, context assembly, each model call, each tool, each HTTP attempt, first substantive text, final response, and final Telegram delivery. Record model/effort, uncached/cache-write/cache-read/output tokens, stop reasons, HTTP retries, cache age/hits, payload size, and result status. Do not rely on the current “done” log: executor errors are returned as strings, so that event does not mean success. Avoid logging full personal messages and routine JSON as the default telemetry format.

Report median/p95 and cost per **successful completed task**, grouped into ordinary chat, check-in, program proposal, approved push, quick edit, history analysis, and recovery. Confirm the running process emits the new fields before treating measurements as post-change data. Add script type checking and a small Node test runner/CI job; keep production emit configuration separate if needed.

### PERF-002 and PERF-003 — Reduce routine-generation work safely

**Severity: high for input correctness; medium for performance.** The local logs show “Push-Up” failing resolution, followed by another full payload using “Triceps Pushdown.” The second payload arrived approximately eight seconds later. This is avoidable generation and can also change a workout the user approved.

In [exercise resolution](../src/hevy/exercise-pins.ts), add explicit aliases for observed spelling/hyphen variants backed by verified template IDs. Do not solve this by accepting progressively broader ambiguous matches. Persist verified mappings through the state layer, and return concise candidate names when unresolved. Template results currently live forever within a process; add explicit refresh-on-miss once, with failure cleanup, so a newly created custom exercise can become visible without restarting. A permanent background refresh service is unnecessary.

Implement [#13](https://github.com/danmunz/hevy-coach/issues/13) with a shared set parser for push and edit: `weight_lbs`, `reps`, optional `count` defaulting to 1, and optional `warmup`. Expand to the existing physical-set representation before persistence and HTTP. Keep existing cached payloads and pounds-to-kg conversion unchanged. Collapse only **consecutive identical sets**; a later repeated weight must retain its position in the workout.

Validate finite nonnegative weights, positive integer reps/counts, supported set types, and array/object shapes. Use the issue's proposed caps of 20 repetitions per group and 40 physical sets per exercise; reject invalid input before any write. Accept legacy `type` during transition, rejecting conflicting `type`/`warmup` values. Replace today's silent missing-weight/reps defaults with actionable validation errors. Zero pounds must still be valid for bodyweight exercises; it does not mean an unloaded barbell. A logged barbell warmup has zero pounds, illustrating why semantic coaching checks also matter.

The goal is identical approved physical workouts with less generated JSON. Do not turn the freeform program markdown into a hard-coded 5/3/1 engine as part of this optimization. Broader deterministic program arithmetic or stored draft/commit workflows are possible later, but would require a separate customization contract.

### PERF-004 and PERF-005 — Reuse data while preserving evidence

**Severity: medium for redundant reads; high for evidence loss.** [The Hevy client](../src/hevy/client.ts:339) independently scans up to 50 workouts for each exercise. The current public API now documents `GET /v1/exercise_history/{exerciseTemplateId}`, with optional `start_date`/`end_date`. Its `exercise_history` array contains per-set entries with workout identity/time, weight, reps, RPE, and set type. It also documents workout-change events for incremental caches and a single-routine read endpoint. These capabilities should replace assumptions in the older review. [Hevy public API documentation](https://api.hevyapp.com/docs/) and its [published OpenAPI definition](https://api.hevyapp.com/docs/swagger-ui-init.js).

Prefer the dedicated history call, grouping entries by workout ID and normalizing pounds at the existing boundary. In a live read-only comparison over the date interval covered by the latest 50 workouts, it returned matching per-workout set counts for the sampled exercise: 19 workouts and 78 sets. Requests fell from five to one and elapsed time from 648 to 178 ms. Verify all relevant fields and date boundaries before replacing the scan; an empty valid history is not a reason to run an expensive fallback scan. Make requested/returned coverage explicit instead of quietly substituting a shorter window. Exercise notes needed for a specific coaching question can still require full workout details.

Then share repeated identical reads: memoize completed results and in-flight requests within a consecutive read phase, clearing failures. Retain a shared page loader for recent workouts, full-workout analyses, and any explicit compatibility fallback. End the read scope at a write barrier; do not move a post-write read before that write. Do not parallelize the existing five-page scan before evaluating the simpler endpoint replacement.

[The summarizer](../src/hevy/summarize.ts:34) keeps only one heaviest normal set. It loses total sets/reps, backoff performance, RPE, exercise notes, and some failure/drop-set information. Consequently the persona's weekly-volume instruction and rules around missed reps cannot be reliably fulfilled from the supplied data. History filtering starts with template IDs, but the final summary matches titles, which can lose older entries after an exercise rename.

Use compact deterministic summaries with template identity, total work sets/reps, repeated set groups, available RPE, and relevant notes. Distinguish set categories rather than silently discarding them. Match exercise history by ID through the final summarization step. Fetch sufficient date coverage for weekly-volume questions; the last five workouts do not necessarily cover the requested week. Do not claim reps were “missed” unless the intended prescription is also known.

This increases summary tokens somewhat. That is justified when it eliminates an additional query or lets the coach assess what actually happened. Also resolve conflicting/ambiguous program instructions with the owner before an effort benchmark; otherwise the model is being scored against an unclear target.

### PERF-006 — Make reasoning effort an explicit, measured choice

**Severity: medium; high potential payoff.** The installed SDK is 0.39.0; npm reported 0.124.0 during this audit. Upgrade on an isolated change with request/response and tool-loop regression fixtures. Keep the model, effort, TTL, and streaming behavior unchanged during the dependency upgrade so regressions can be attributed correctly.

Then benchmark explicit `medium` effort against the existing default, with `low` as a second candidate. Anthropic documents Sonnet 5's default as `high` and identifies lower effort as suitable for latency-sensitive chat. Effort affects thinking, text, and tool use; it is not a hard token budget. Keep effort fixed within each evaluation session: changing the top-level setting can invalidate cached prefixes. [Anthropic effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

Promote medium only if approved-payload accuracy, injury/constraint handling, program interpretation, and confirmation behavior hold. Retain high as a simple configuration rollback. Avoid a separate LLM router on every message: it adds inference and complicates both latency and cache accounting. A smaller model is a later benchmark candidate, not a necessary prerequisite to making this bot fast.

Do not lower the 16,000-token cap as the first fix. It is a ceiling rather than a requirement to generate 16,000 tokens; this repository already experienced truncation at 4,096. Measure actual output and termination rates after compaction and effort tuning.

### PERF-007 — Remove avoidable model round trips before adding cron

**Severity: medium.** [Issue #4](https://github.com/danmunz/hevy-coach/issues/4) combines two different optimizations: caching Hevy responses and inserting them before the first model request. The latter can save more because a cache behind a tool still requires the model to request that tool.

Start with a narrow, opt-in request-time snapshot for explicit check-in/session-planning flows: fresh recent workouts plus standing-routine state, fetched concurrently and placed in the volatile prompt suffix. Include fetch time and coverage. Retain normal tools for missing details, refreshes, and arbitrary chat. Keep the Markdown configs read on every message and preserve the existing static breakpoint.

Initially refresh this snapshot on each eligible turn; sharing requests within the turn still applies. This proves whether eliminating the initial tool-selection call is worthwhile without introducing stale cross-turn state. If subsequent telemetry justifies cross-turn reuse, start with a short TTL and explicit force-refresh behavior; mutations invalidate routine state, and “just finished” messages require fresh completed workouts. Any pre-overwrite decision must use current state. Match the standing routine by its stored ID where possible, not just its fun title.

Only add scheduled warming after on-demand data reuse proves insufficient. A 5:30 a.m. snapshot accepted for 12 hours is not an appropriate default for someone who can finish or edit workouts during that window. Cron also pays for unused refreshes and adds process ownership concerns. Never place changing snapshots in the cached static prefix.

### PERF-008 — Cache economics and context discipline

**Severity: medium.** Preserve the working static prefix. Move genuinely invariant orchestration instructions currently in the volatile suffix into the static block, leaving time, state, and first-conversation detection below it. This is a small, low-risk gain; it will not transform response time.

Using the historical #14 sample and current standard Sonnet 5 prices, the two-call turn has 3,989 uncached input tokens, a 6,129-token reusable prefix, and 706 total output tokens:

| Cache condition | Input cost | Output cost | Total per turn |
| --- | ---: | ---: | ---: |
| Hypothetical no caching | $0.03249 | $0.00706 | **$0.03955** |
| Cold 5-minute write, then intra-turn read | $0.02453 | $0.00706 | **$0.03159** |
| Prefix already warm for both calls | $0.01043 | $0.00706 | **$0.01749** |
| Cold 1-hour write, then intra-turn read | $0.03372 | $0.00706 | **$0.04078** |

These are recalculated scenarios, not invoices. At 100 such turns, the first three cases are about $3.96, $3.16, and $1.75 in model usage. Real routine pushes, retries, and longer reasoning change that mix; “conversations” and “API calls” are not interchangeable units. Standard prices used are $2/M input, $10/M output, $2.50/M five-minute writes, $4/M one-hour writes, and $0.20/M reads. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

For this prefix, upgrading the first fill to one hour adds approximately **$0.00919**. Each later five-minute miss that becomes a hit saves approximately **$0.01410**. One such avoided miss can recover the premium, but isolated sessions more than an hour apart cannot. Simulate both policies over actual request timestamps, accounting for refresh on cache reads, content changes, model/effort changes, and cold starts. Keep five minutes as the default until the measured workload favors one hour. Do not keep the cache warm using paid dummy requests. [Prompt-cache mechanics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

The current history is bounded by messages, not tokens; active notes are unbounded. Add token-aware selection of complete recent exchanges before aggressively shortening the window. Preserve pending proposals/approvals and persistent constraints separately if they would otherwise fall out. Start with the existing ~3,000-token target for uncached state plus history as an observable target, not a reason to silently drop essential notes. If essential state exceeds the budget, surface it for consolidation. A model-generated rolling summary adds cost and can omit important details, so defer it until actual history pressure warrants it.

A later intra-turn cache breakpoint could reuse the stable suffix/history across repeated calls, but the clock prevents ordinary cross-turn reuse of that entire prefix and a new cache write must itself earn a read. Test it separately after simpler improvements; do not indiscriminately cache every growing tool result.

### PERF-009 — Bound slow failures and serialize conversations

**Severity: high.** [The current chat loop](../src/claude/client.ts:95) inherits SDK defaults of ten minutes per request and two retries. Installed Telegraf defaults to a 90-second handler timeout. The Hevy wrapper can spend approximately 51 seconds on three 15-second timeouts plus 2/4-second sleeps for just one HTTP operation; `Retry-After` can extend waiting further. Ten tool iterations are not an end-to-end time budget.

Introduce a shared turn deadline and cancellation signal checked before each model request, tool, write, and backoff. As a starting policy for evaluation, use a 75-second processing budget, up to 45 seconds per model attempt, and retries only when sufficient time remains. Reserve delivery time below Telegraf's timeout. Tune from measured slow-but-successful turns. A timer that only returns a fallback while work continues is insufficient: verify no later tools run after cancellation and clear status timers in `finally`.

Make retries method-aware. GET retries are generally reasonable. A timed-out POST may have created a routine already; reconcile the outcome before repeating it, and report uncertainty if it cannot be established. Do not automatically replay a whole turn after some tools succeeded. Preserve confirmed write outcomes even if the final model answer fails. Group related local state updates and user/assistant history inserts in SQLite transactions; this improves integrity more than speed.

Telegraf's installed polling loop waits for the current batch's handlers, then polls again; updates within one batch run concurrently. Thus follow-up messages can either wait unseen behind a long turn or race within a batch. Add one owner-level queue and serialize history/state-changing chat turns, retaining read concurrency inside a turn. If fast receipt of follow-ups is required, make intake enqueue promptly and let a single worker process turns; document queue durability rather than accidentally acknowledging work that will disappear on restart. Measure receipt/queue delay separately from inference. Keep this a single-process queue, not a new messaging service.

### PERF-010 — Make progress visible and remove delivery waste

**Severity: medium for failure handling; low for healthy-path performance.** Implement [#17](https://github.com/danmunz/hevy-coach/issues/17) through a transport-neutral progress callback supplied to `chat()`: accepted, reading, preparing, writing, complete/failed. Map it to reactions or one editable status message in Telegram. Status failures must not fail the turn. The initial `replyWithChatAction` currently runs before the handler's `try` and is awaited before work starts; make it best-effort too.

[Telegram delivery](../src/telegram/client.ts:148) splits at 800 characters and adds 400 ms between chunks. Three chunks impose 0.8 seconds of deliberate pacing plus three sends. Start by removing artificial delay and using paragraph-aware chunks around 2,000 characters, preserving mobile readability. Repair tag/entity boundaries and only retry without HTML on an actual formatting rejection. Today every send error triggers a plain-text retry, including errors for which that fallback is inappropriate.

Streaming can reveal final prose earlier, but cannot reveal a completed routine while the model is still generating tool arguments. If added, use throttled edits, never display thinking blocks or partial tool JSON, and never announce write success before the tool confirms it. Measure time to meaningful text separately from total completion time. It does not inherently reduce tokens or total generation work. [Anthropic latency guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency).

## Sequencing, acceptance, and rollout

Use separate atomic commits/PRs so each effect can be attributed and reverted. The effort estimates below are rough focused engineering time, excluding the observation window.

| Stage | Deliverable | Verification and release gate | Rough effort |
| --- | --- | --- | --- |
| 0 | PERF-001: scratch evaluation, dependency seams, metrics, CI/type checking of scripts | No writes to production DB/Hevy in default evaluation mode; success/error/truncation/iteration-limit paths covered; deployed logs identify revision and turn | 1–2 days |
| 1 | PERF-002/003: shared validation, verified aliases, compact sets; small PERF-010 progress fix | Expanded payload exactly matches fixture prescription; zero malformed writes; correct bodyweight/barbell handling; two consecutive edits preserve state | 1–2 days |
| 2 | PERF-004/005: direct exercise history, shared reads, richer deterministic evidence; PERF-009 deadlines/serialization | Each exercise history uses one request for its bounded date interval; compare field/coverage parity to full workouts; identical concurrent reads deduplicate; write barriers and cancellation hold | 2–4 days |
| 3 | PERF-006: SDK upgrade, then effort evaluation as separate change | Same request/tool semantics after upgrade; medium effort passes all critical coaching cases and improves median task latency or cost by at least 15% with no material p95/error regression | 1–2 days plus evaluation |
| 4 | PERF-007/008: fresh context injection, then TTL/context tuning individually | Eligible check-ins use one fewer model call; completed/edited workouts remain fresh; cache billing simulation shows net savings | 1–3 days plus a week of observations |
| 5 | Further delivery/streaming or model alternatives if still needed | Earlier substantive feedback, no partial/false success messages, no increased completion cost or delivery-error rate | Separately scoped |

The 15% gate is a proposed engineering decision threshold, not a promised gain. Changes whose main benefit is correctness can ship without meeting a speed threshold.

Build fixtures for: ordinary chat; morning check-in; skipped/queued routine; low-energy/short-time adjustments; reported pain; progression and TM approval/refusal; an approved full workout; ascending warmups and main sets; repeated supplemental sets; two successive substitutions; bodyweight sets; aliases and ambiguous matches; renamed exercise IDs; a workout just completed/edited externally; 429 and 5xx responses; timeouts before/after a write; partial generation; two rapidly arriving messages; and malformed Telegram HTML.

For model comparisons, run at least five repetitions per scenario under controlled cold/warm cache conditions. Compare per-scenario medians and task correctness; do not claim a stable p95 from a handful of runs. Use a larger real-use sample for tail latency. Critical gates are zero unapproved writes/TM changes, exact exercise/weight/reps/order on approved payloads, preserved constraints, and no false success after a failed or uncertain write. Judge tone and coaching usefulness separately from payload correctness.

Every code commit must pass `npx tsc --noEmit` and the affected-flow tests. After relevant changes, use the newly isolated CLI for the required smoke tests. Pin/template changes also require `npm run setup` verification in the isolated environment. A designated live test routine can validate Hevy's physical set display before rollout; never use the standing workout as an incidental benchmark target.

Observe one change at a time over real use. Keep simple rollback settings for effort, TTL, context injection, and progress display. Update README for new scripts/settings and customization behavior, and update stale prefix-size documentation. Record verification against these PERF IDs. Do not count mock assertions as live Hevy verification.

## Work to defer

- **SQLite replacement, async filesystem conversion, query caches, and ORM work:** current local assembly is about half a millisecond. A timestamp index or replacing `COUNT(*)` with `EXISTS` may be sensible later, but cannot explain seconds of latency now. Keep WAL and direct state access.
- **Precompiled JavaScript instead of `tsx`:** could reduce startup/resource overhead; no evidence it materially slows steady-state turns. Revisit only if restart or RSS measurements justify it.
- **Cloud migration, #5:** an availability project if the laptop sleeps, not a proven inference-speed fix. Re-estimate hosting prices separately rather than inheriting the issue's old quotes. Retain single-process/persistent-storage assumptions.
- **Multiple providers, #6, and other transports, #18:** legitimate product options, but large scope relative to the performance wins above. Progress callbacks can remain transport-neutral without building the entire abstraction now.
- **Proactive messages, #8:** adds model/API usage and notification decisions; it should not be justified as an optimization of the current interactive path.
- **Permanent template prewarming or a full synchronized workout warehouse:** defer until measured misses or analysis depth require them. Direct exercise history and per-read-phase sharing capture immediate gains with much less machinery. If a persistent workout cache later becomes worthwhile, use the documented update/delete events rather than assuming new-workout counts detect edits and deletions.

The audit verification is complete: source/dependency inspection, remote issue reconciliation, local microbenchmark, mocked read/retry/summary checks, a live read-only exercise-history comparison, and type checking. Performance fixes themselves remain proposed and unimplemented.
