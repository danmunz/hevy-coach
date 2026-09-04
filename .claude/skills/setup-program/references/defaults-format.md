# defaults.json Format

## Schema

```json
{
  "training_maxes": "{\"squat\": 205, \"bench\": 155, \"deadlift\": 275, \"ohp\": 95}",
  "goals": "Preserve muscle during cut, maintain or slowly progress strength"
}
```

**Important**: `training_maxes` is a JSON **string** (not a nested object).
This is how `src/state/config.ts` reads it — it parses the string at runtime.
The keys must be exactly `squat`, `bench`, `deadlift`, `ohp` — the
`TrainingMaxes` interface in the codebase requires all four.

**Seeding behavior**: `seedDefaults()` uses `INSERT OR IGNORE` — it only
writes values that don't already exist in SQLite. Re-running `npm run setup`
on an existing database will NOT update training maxes or goals. To update
live values, the user must either tell the bot in chat (it has an
`update_training_maxes` tool) or delete the database and re-run setup.

## Values

- All TM values in lbs, rounded to nearest 5
- `goals` is a free-text string (1-2 sentences)

## TM Conversion Formulas

When the user provides something other than training maxes:

**From 1RM**:
```
TM = round(1RM * 0.85 / 5) * 5
```

**From a rep max** (e.g., "I squatted 185 for 5"):
```
estimated_1RM = weight * (1 + reps / 30)    // Epley formula
TM = round(estimated_1RM * 0.85 / 5) * 5
```

**"I don't know"**:
Suggest conservative starting points. Ask what weight they feel comfortable
doing for 5 reps on each lift, then use that as approximately the TM
(since TM should be submaximal). Better to start too light.

## Programs Without All Four Lifts

If the program doesn't use all four lifts (e.g., PPL without dedicated OHP),
still populate all four keys. Note in the conversation which values are
primary lifts vs. estimated. The interface requires all four.
