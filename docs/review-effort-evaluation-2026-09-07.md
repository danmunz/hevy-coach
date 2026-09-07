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

**Blocked by API account credit.** Do not change the production effort from
`high`. Once credit is available, run:

```bash
npm run evaluate:effort -- high 5
npm run evaluate:effort -- medium 5
```

Promote `medium` only if every scenario passes every repetition and it improves
the selected latency or model-cost measure by at least 15%, without an error or
tool-behavior regression. Retain the generated JSON results outside Git because
they can reflect the current personal coaching context.
