---
name: setup-program
description: >
  Generate config/program.md and config/defaults.json through a guided
  conversation — the training program structure and initial training maxes.
  Use when the user says /setup-program, "set up my program," "change my
  program," "switch programs," "set up training maxes," or wants to configure
  a new training program. Supports recognized programs (5/3/1, Starting
  Strength, GZCLP, PPL, nSuns, PHUL, etc.) and custom programs. Also
  suggests exercise pin changes.
---

# Setup Program

Generate two files:
- `config/program.md` — training program structure (hot-reloaded)
- `config/defaults.json` — initial training maxes and goals (used by `npm run setup`)

Also suggest exercise pin changes for `src/hevy/exercise-pins.ts` (displayed
to the user as a copy-paste snippet, not auto-applied).

## Workflow

1. **Check for existing file**

   Read `config/program.md`.
   - **File exists?** → "I see you already have a program configured. Want to
     modify it, or start fresh?" If modifying, read the file and ask what changed.
   - **No file?** → Proceed with full flow.

2. **Program selection**

   Ask: "What program are you running?" Offer options:
   - 5/3/1 (Wendler) — which variant? (BBB, FSL, BBS, custom)
   - Starting Strength / Linear Progression
   - GZCLP
   - PPL (Push/Pull/Legs)
   - nSuns
   - PHUL (Power Hypertrophy Upper Lower)
   - Upper/Lower split (generic)
   - Full Body 3x/week
   - "I have my own program"

3. **Determine path**

   - **Recognized program?** → Follow "Recognized path" below
   - **Custom program?** → Follow "Custom path" below

### Recognized path

Fill in the program structure from knowledge. Present a summary:
"Here's how I'd set up [Program]. Sound right?"

Confirm key decision points (ask only what's relevant to the chosen program):
- "How many days per week are you training?"
- "Any modifications from the standard program?"
- For 5/3/1: "Which variant — BBB, FSL, or something else? AMRAP top sets
  or straight sets (5s PRO)?"
- For PPL: "6 days (PPLPPL) or 3 days (rotating)?"
- For Starting Strength: "Adding any accessories?"

### Custom path

Offer: "You can describe your program, or I can walk you through building it.
You can also share a file or document if you have one written up."

- **File provided** → Read it, parse program structure, present summary
  for confirmation.
- **No file** → Walk through with these questions (one or two at a time):
  1. "How many days per week do you train?"
  2. "What's the split? (Upper/Lower, PPL, full body, body part split, etc.)"
  3. "What are your main compound lifts and how do they progress?"
  4. "What does a typical session look like? (warmups → main → supplemental
     → accessories?)"
  5. "How do you handle progression between sessions or weeks?"
  6. "How should the bot figure out where you are in the program from your
     Hevy workout history?"

4. **Training maxes**

   "What are your current training maxes (or best recent sets) for your
   main lifts?"

   Accept various formats and convert:
   - Direct TMs: "Squat 205, Bench 155, Deadlift 275, OHP 95"
   - 1RMs: convert to TM
   - Recent sets: estimate 1RM via Epley, then convert to TM
   - "I don't know": suggest conservative starting points

   Read `references/defaults-format.md` for the conversion formulas and
   JSON schema.

   Programs that don't use all four lifts: still populate squat, bench,
   deadlift, and ohp — the interface requires all four. Note which are
   primary vs. estimated.

5. **Training context and goals**

   Ask two questions:
   - "What's your current training context? (bulking, cutting, maintaining,
     rehabbing, preparing for a meet, general fitness)"
   - "One-sentence goal for right now?"

6. **Generate outputs**

   Generate three things:

   **a) `config/program.md`** — Read `references/program-template.md` for
   the required section structure. The "Determining Where I Am in the Program"
   section is critical — without it the bot cannot figure out what to program
   next. The "Weight Formatting" section is always the same (copy verbatim
   from the template).

   Read the existing `config/program.md` (if present) as a worked example.

   **b) `config/defaults.json`** — Read `references/defaults-format.md` for
   the exact schema. Note that `training_maxes` is a JSON string, not a
   nested object.

   **c) Exercise pin suggestions** — Read `src/hevy/exercise-pins.ts` and
   compare the current pins to what this program needs. Output:
   - Pins to add (with `query` and optional `primaryMuscleGroup`)
   - Pins that may no longer be needed
   - A TypeScript snippet the user can paste

7. **Confirm or refine**

   Show program.md and defaults.json to the user.
   "How does this look? I can adjust the structure, change weights, or
   tweak any section."

   Loop until approved. Write both files.

8. **Exercise pin instructions**

   Display pin suggestions separately:
   "To apply these pin changes, edit `src/hevy/exercise-pins.ts`, then run
   `npm run setup` to resolve the new pins against the Hevy API."

9. **Compatibility warnings**

   If the program differs significantly from 5/3/1:
   - Warn that `config/rules.md` contains 5/3/1-specific TM update logic
     (End-of-Cycle TM Updates: +5 upper, +10 lower). The user may need to
     update that section for their program's progression scheme.
   - Warn that the `TrainingMaxes` interface is fixed at squat/bench/deadlift/ohp.
     If their program uses different main lifts, they'll need to map their lifts
     to these four keys.

10. **Next steps**

    If this is a **first-time setup** (no database yet):
    "Your program and training maxes are saved. Run `npm run setup` to create
    the database and seed these values."

    If the **database already exists** (the user is changing programs):
    "Your program file is saved and takes effect on the next message (hot-reload).
    However, `defaults.json` only applies on first-time `npm run setup` — it
    won't overwrite existing training maxes in the database. To update your
    live training maxes, either:
    - Tell the bot your new maxes in chat (it has an `update_training_maxes` tool), or
    - Delete `data/hevy-coach.db` and re-run `npm run setup` to start fresh."

    If exercise pins were suggested:
    "To apply pin changes, edit `src/hevy/exercise-pins.ts`, then run
    `npm run setup` to resolve the new pins against the Hevy API."

    "If you haven't set up your coach persona or equipment yet, run
    `/setup-coach` or `/setup-equipment`."
