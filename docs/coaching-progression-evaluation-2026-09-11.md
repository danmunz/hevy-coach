# Coaching progression evaluation — 2026-09-11

## Scope

This evaluation covers the accessory progression, load-calibration, and
conversational completed-session-review instructions added to the cached
configuration prompt. It does not evaluate exercise preferences, durable
cycle reviews, proactive messaging, or production Hevy API behavior.

## Method

`npm run evaluate:coaching` ran each scenario twice using the configured
`claude-sonnet-5` model at `medium` effort. Each run used a fresh temporary
SQLite database and an injected fake Hevy client. The client records tool
calls and writes, and cannot access the network.

Automated checks require read-only tool behavior, no Hevy routine writes, no
durable state mutation, normal model completion, and an exact exercise-history
lookup where history is required. A second-turn variant-calibration case
checks that the first completed V-grip row exposure becomes its own baseline.

The captured result artifact was written to
`/tmp/hevy-coaching-results-verified.json` during verification. It is
deliberately not committed because it contains model responses and timestamps.

## Result

All 22 runs passed automated checks. Manual response review confirmed that
the model:

- advances a cable accessory after two complete ceiling-rep exposures with
  reported RPE 7-8, using the available 2.5 lb pulley increment;
- retains load after one qualifying exposure, below-ceiling work, missing
  effort, or a first calibration exposure;
- asks for missing effort rather than treating a prescribed target as a
  logged RPE;
- does not invent a heavier kettlebell or automatically add a set at the
  available-equipment ceiling;
- preserves Week 1 bench and OHP FSL values from training-max percentages;
- reviews performed squat work without treating a queued accessory as
  completed, and avoids unsolicited duplicate reviews;
- labels unfamiliar loads as provisional, distinguishes unavailable from
  empty history, and does not transfer a bar-grip row load to V-grip rows.

## Limits

The evaluator verifies tools and durable state mechanically, but evaluates
coaching prose using the saved scenario rubrics and manual review. It cannot
prove model behavior for every possible phrasing, equipment configuration, or
real Hevy response. It also does not perform live routine writes. Repeat the
evaluation after material prompt, model, or tool changes; use `--dry-run` only
to validate evaluator setup, not coaching behavior.
