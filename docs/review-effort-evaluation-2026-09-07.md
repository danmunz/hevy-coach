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
