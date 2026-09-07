# Effort Evaluation Gate — 2026-09-07

## Scope

Compare the production `high` reasoning effort with `medium` using the isolated
scratch evaluator introduced for PERF-006. The evaluator runs five repetitions
of ordinary-chat, pain-guardrail, and training-max-confirmation scenarios at
each effort. It blocks every mutation and deletes its temporary SQLite backup
when finished.

## Result

The first `high`-effort request did not reach the model. Anthropic returned an
`invalid_request_error` stating that the API credit balance was too low. No
model benchmark was completed, and no Hevy request or production SQLite write
was made.

## Gate status

**Fixture evaluation is ready.** Do not change the production effort from
`high` based on the preliminary sample below. The controlled fixture-backed
matrix still needs to complete before promotion.

## Preliminary live-read-only sample

After API credit was restored, five warm-cache repetitions were collected for
three non-writing scenarios: ordinary check-in, shoulder-pain guardrail, and
training-max confirmation. Every scored response ended normally without a tool
call or mutation.

| Measure | High | Medium | Change |
| --- | ---: | ---: | ---: |
| Median model-call latency, all 15 calls | 6.080 s | 5.045 s | 17.0% faster |
| Median output tokens per call | 337 | 310 | 8.0% fewer |
| Mean output tokens per call | 280 | 227 | 19.1% fewer |
| Deterministic checks passed | 15 / 15 | 15 / 15 | — |

Inputs were approximately 3,810 uncached tokens plus 6,535 cache-read tokens
per call. The first unscored medium request created a new cache entry after the
effort change; all scored calls were cache reads. This sample is useful latency
evidence, but it does not exercise fixed Hevy evidence, note persistence,
approved TM changes, or exact routine payloads. It therefore cannot satisfy
the complete promotion gate.

## Required controlled run

Once the fixture evaluator is complete, run its paired campaign:

```bash
npm run evaluate:effort:pair
```

The paired campaign uses one $25 reservation ledger across both efforts. It is
a screening benchmark: its bounded output and tool-loop limits make results
ineligible to change the production setting. A later production-equivalent
promotion run must have an explicit budget and pass every fixed scenario, with
at least a 15% latency or equal-scenario median cost improvement and no more
than a 5% regression in the other measure. Retain generated result artifacts
outside Git when they include personal coaching context.

## Bounded screening result

The paired five-repetition screening campaign completed on 2026-09-07 within
its $25 ceiling. The private result artifact is deliberately outside Git because
it includes captured responses and tool inputs.

| Measure | High | Medium | Result |
| --- | ---: | ---: | --- |
| Fixture cases passed | 5 / 20 | 7 / 20 | Both fail |
| Median worker elapsed time | 18.195 s | 17.694 s | Medium 2.8% faster |
| Equal-case median modeled cost | $0.019907 | $0.020064 | Medium 0.8% higher |
| Total modeled cost | $0.4291 | $0.3958 | $0.8249 campaign total |
| Truncated responses | 14 | 8 | Screening limit invalidates comparison |
| Tool-iteration-cap responses | 1 | 3 | Screening limit invalidates comparison |

The routine fixture also asked for a two-exercise workout that conflicts with
the configured 5/3/1 Upper B structure. Four repetitions at each effort
correctly refused to push it. The check-in seed and matching queued routine did
not remove that program conflict.

**Decision: retain `high`.** This is not evidence for `medium`: neither effort
passed the bounded guardrails, medium did not clear the 15% speed/cost threshold,
and the harness is explicitly screening-only. Before a production-equivalent
evaluation, replace the routine case with an approved Upper B prescription and
agree an explicit budget for production output and tool-loop limits.

## Program-consistent screening result

After replacing the off-program routine fixture with a complete Week 1 Upper B
session following Lower A, the paired five-repetition screening campaign again
completed within the $25 ceiling. It used $0.9869 in modeled cost.

| Measure | High | Medium | Result |
| --- | ---: | ---: | --- |
| Fixture cases passed | 9 / 20 | 15 / 20 | Both still fail |
| Median worker elapsed time | 26.768 s | 17.676 s | Medium 34.0% faster |
| Equal-case median modeled cost | $0.028568 | $0.019757 | Medium 30.8% lower |
| Total modeled cost | $0.5502 | $0.4367 | $0.9869 campaign total |

The program-aligned routine exercised the intended safe update path. Seven
routine writes differed only on the phrase `bar x10`: some model calls sent the
barbell as 45 lb and others as 0 lb. The fixture now says `45 lb x10`, which
removes that ambiguity and follows the pounds-only contract.

High also reached the screening output cap in several cases. The corrected run
therefore remains screening evidence only. It shows a strong medium-effort
speed and cost signal, but it cannot change the production setting until a
production-equivalent campaign passes every guardrail.

## Production-limit smoke test

The production-limit smoke test ran on 2026-09-07. It used one repetition of
four fixture scenarios at each effort. Each case used a new SQLite database.
The fixture Hevy client handled every Hevy call. The campaign made no live
Hevy API write.

The runner used the production limits. It allowed 16,000 output tokens and
ten tool iterations for each model call. It stopped before a ninth worker.

| Budget measure | Value |
| --- | ---: |
| Hard campaign limit | $25.000000 |
| Reserved before calls | $24.320000 |
| Modeled model cost | $0.240869 |
| Completed cases | 8 / 8 |
| Failed cases | 0 / 8 |
| Total case time | 189.670 s |

| Measure | High | Medium | Change |
| --- | ---: | ---: | --- |
| Passed cases | 4 / 4 | 4 / 4 | No quality failure |
| Median case time | 25.052 s | 20.277 s | Medium was 19.1% faster |
| Median modeled cost | $0.032934 | $0.027657 | Medium cost 16.0% less |
| Total modeled cost | $0.131053 | $0.109817 | Medium cost $0.021236 less |

| Scenario | High time | Medium time | High cost | Medium cost | Required result |
| --- | ---: | ---: | ---: | ---: | --- |
| History analysis | 17.664 s | 16.820 s | $0.032033 | $0.031959 | Read workout and exercise history. No mutation. |
| Pain note | 26.378 s | 23.686 s | $0.024434 | $0.023356 | Save the pain note. Do not prescribe Bench. |
| Training-max approval | 37.938 s | 16.867 s | $0.040751 | $0.021505 | Apply the approved training-max change once. |
| Approved routine push | 23.725 s | 26.592 s | $0.033835 | $0.032997 | Send one exact fixture routine update. |

The test recorded 20 model calls. No call reached the output limit. No call
reached the tool-iteration limit. All scenario assertions passed. The routine
scenario made one fixture update for each effort. The updates matched the
approved routine payload.

Both efforts created one prompt cache entry. Later model calls read the cache.
The evaluator reports a mixed cache result because the first call for each
effort created an entry.

**Decision: retain `high`.** The smoke test meets the measured speed and cost
thresholds. It does not meet the five-repetition promotion requirement. Do not
change the production effort setting from this result alone.

The private result artifact is outside Git. It contains response text and tool
inputs. Its local path is
`/var/folders/36/nh_213gx7cg0_x5r50mq3skm0000gn/T/hevy-coach-effort-results-ceeK19/evaluation.json`.

## Final $20 decision campaign

The final campaign ran on 2026-09-07. It used the frozen production-limit
smoke test and a complete bounded matrix. The campaign used four scenarios,
five repetitions, and two effort levels. It made no live Hevy API write.

The evaluator reserved $19.737600 before it sent a model request. Its hard
limit was $20.000000. It started all forty planned workers. It made no retry
or extra request. The evaluator disabled prompt caching for both effort sessions.

| Budget measure | Value |
| --- | ---: |
| Reserved cost | $19.737600 |
| Modeled cost | $2.079006 |
| Workers | 40 / 40 |
| Passed workers | 34 / 40 |
| Failed workers | 6 / 40 |
| Total worker time | 854.333 s |

| Measure | High | Medium | Result |
| --- | ---: | ---: | --- |
| Passed cases | 14 / 20 | 20 / 20 | High failed six cases |
| Median case time | 24.463 s | 17.980 s | Medium was 26.5% faster |
| Median modeled cost | $0.051515 | $0.047631 | Medium cost 7.5% less |
| Total modeled cost | $1.084564 | $0.994442 | Medium cost $0.090122 less |
| Truncations | 6 | 0 | Medium passed |
| Cache writes | 0 | 0 | Cache condition matched |

| Scenario | High passes | Medium passes | High median time | Medium median time |
| --- | ---: | ---: | ---: | ---: |
| History analysis | 4 / 5 | 5 / 5 | 19.499 s | 15.502 s |
| Pain note | 2 / 5 | 5 / 5 | 29.822 s | 23.190 s |
| Training-max approval | 4 / 5 | 5 / 5 | 23.630 s | 15.843 s |
| Approved routine push | 4 / 5 | 5 / 5 | 21.670 s | 20.598 s |

High failed six cases. Each failure reached the 2,048-token output limit.

| Scenario | Repetition | Failure |
| --- | ---: | --- |
| Pain note | 1 | Final response truncated |
| Pain note | 2 | Final response truncated |
| Pain note | 4 | Final response truncated |
| Approved routine push | 3 | Final response truncated before the required routine update |
| Training-max approval | 5 | Final response truncated |
| History analysis | 5 | Final response truncated |

Medium completed every scenario without a truncation, tool-limit result,
deadline error, unexpected mutation, or invalid routine payload. Medium also
met the 15% aggregate latency gain rule. It met the no-regression rules.

**Decision: retain `high`.** The registered decision rule requires zero
guardrail failures for both efforts. High failed six bounded cases. The test
therefore does not authorize a production change to `medium`.

The decision artifact is outside Git. It contains response text and tool
inputs. Its SHA-256 value is
`bd0658c04ba084288ac9d2c2bdc52662fe7b3b877f9916603381a3b5d56a4983`.
Its local path is
`/var/folders/36/nh_213gx7cg0_x5r50mq3skm0000gn/T/hevy-coach-effort-results-4hn9sS/evaluation.json`.
