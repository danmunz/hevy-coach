# Current Program: 5/3/1 Upper/Lower Split (Muscle Preservation)

## Training Context
Currently cutting on tirzepatide (~200 → goal weight TBD). 
Training priority is preserving muscle mass while the cut does 
its work. Strength may stall or dip slightly — that's expected, 
not a failure. Chase consistency and volume, not PRs.

## Structure
4 training days per week, alternating Upper and Lower:
- Upper A: OHP main lift, Bench supplemental
- Lower A: Squat main lift
- Upper B: Bench main lift, OHP supplemental
- Lower B: Deadlift main lift, Front Squat supplemental

Rotation is fixed in this order. If a session is skipped, 
pick up where the rotation left off — don't skip ahead.

## The 5/3/1 Waves
3-week cycle, all percentages based on training max (TM):
- Week 1 (5s): 65% x5, 75% x5, 85% x5
- Week 2 (3s): 70% x3, 80% x3, 90% x3
- Week 3 (1s): 75% x5, 85% x3, 95% x1

Running 5s PRO during the cut — no AMRAP sets. All work sets 
are straight sets at the prescribed reps. This is a deliberate 
choice: grinding reps in a caloric deficit increases injury risk 
and recovery cost without meaningful benefit. If the user is 
feeling great on a given day, coach.md adjustment logic can 
override this (add an AMRAP or a heavier single).

Week 4 is a deload: 40% x5, 50% x5, 60% x5.

## Warmup Sets
Program 2-3 warmup sets ramping to the first work set. 
Use common-sense plates:
- If the first work set is under 100 lbs: bar x10, then one 
  warmup at ~60-70% of the first work weight
- If the first work set is 100+: bar x10, a mid-weight set of 
  5, optionally a heavier set of 3
- The last warmup must be BELOW the first work set

## Supplemental Work

Upper days pair the two pressing movements. The non-main press 
gets supplemental volume at FSL weight (same percentage as the 
first work set, applied to that lift's TM):
- Upper A (OHP main): Bench 5x5 @ FSL% of Bench TM
- Upper B (Bench main): OHP 5x5 @ FSL% of OHP TM

Lower A (Squat main): No barbell supplemental. Posterior chain 
accessories fill this slot (e.g., good mornings, KB swings).

Lower B (Deadlift main): Front Squat 3x8. Start conservative 
(~95 lbs) and progress by feel, not by percentage. Front squats 
reduce spinal compression overlap with deadlifts and shift 
emphasis to quads and anterior core.

## Accessories

Each session gets 50-100 total reps across push, pull, and 
single-leg/core categories. Use the equipment list to select 
exercises — the cable pulley opens up a lot of options.

Guidelines, not rigid rules:
- Every session includes pulling work (rows, pulldowns, curls). 
  Back can never get too much volume.
- Upper days: pull + push accessories, typically supersetted. 
  Vary between the two upper days (e.g., barbell curls on one, 
  hammer curls on the other).
- Lower days: posterior chain or single-leg work + core. Vary 
  the core movement between the two lower days (e.g., hanging 
  knee raises on squat day, reverse crunches on deadlift day).
- Superset accessories where possible to keep sessions under 
  50-60 minutes.
- Dumbbell and cable accessories should be moderate weight, 
  higher reps (10-20 range). The main and supplemental lifts 
  handle the heavy work.
- Don't repeat the same accessory combination two sessions 
  in a row. Rotate exercises across weeks to provide variety 
  and hit muscles from different angles.

## Progression
After each 3-week cycle: +5 lbs to upper TMs (Bench, OHP), 
+10 lbs to lower TMs (Squat, Deadlift).

See rules.md for end-of-cycle TM update protocol — never 
update without user confirmation.

## Determining Where I Am in the Program
Hevy history is the source of truth. Look at:
1. The main lift in each recent session → tells you the rotation
2. The working weights relative to TMs → tells you the week
3. The next session follows whatever was done most recently
If it's ambiguous (skipped sessions, changed order), ask.

## Weight Formatting
All weights are authored in lbs and must round to the nearest 
5 lbs (standard plate math). When sending to the Hevy API, 
convert using 0.001 kg precision:

    weight_kg = round(weight_lb × 0.45359237, 3)

This preserves clean lb display in the Hevy app.