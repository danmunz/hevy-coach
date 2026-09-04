# Program Output Template

ALWAYS use this section structure when generating `config/program.md`.
The exact section names may vary by program, but these sections are required:

```markdown
# Current Program: [Program Name] ([Variant or Context])

## Training Context
[1-3 sentences: current training phase (bulking, cutting, maintaining, etc.),
priorities, and relevant context that affects programming decisions.]

## Structure
[Days per week, split layout (what days train what), rotation rules.
If a session is skipped, explain how the rotation handles it.]

## [Main Progression Scheme]
[Name this section after the program — "The 5/3/1 Waves", "Linear Progression",
"RPE Targets", etc. Include:]
- Set/rep schemes with percentages, RPE targets, or weight jumps
- How cycles or phases work
- Deload protocol if applicable

## Warmup Sets
[How to program warmups for main lifts. Include plate math guidance
based on the first work set weight.]

## Supplemental Work
[If the program has supplemental volume (BBB, FSL, etc.), describe it here.
If not applicable, omit this section entirely.]

## Accessories
[Volume targets per session (e.g., 50-100 reps across push/pull/core).
Exercise selection guidelines. Superset preferences. Rep ranges for
accessories vs. main lifts. Variety expectations across sessions.]

## Progression
[How weights/volume increase between sessions, weeks, or cycles.
Reference rules.md for the TM update protocol.]

## Determining Where I Am in the Program
[CRITICAL — without this section the bot cannot figure out what to program.
Explain how to read Hevy workout history to determine:]
1. Which session is next in the rotation
2. Which week/phase the user is in
3. What to do if the history is ambiguous (ask the user)

## Weight Formatting
All weights are authored in lbs and must round to the nearest
5 lbs (standard plate math). When sending to the Hevy API,
convert using 0.001 kg precision:

    weight_kg = round(weight_lb * 0.45359237, 3)

This preserves clean lb display in the Hevy app.
```

## Token Budget

Target ~1500 tokens (~100 lines). This is the longest config file.
If the generated file exceeds ~120 lines, suggest trimming — focus
on what the bot needs to program workouts, not general education.

## Required Sections

These sections MUST appear in every generated program.md:
- **Determining Where I Am in the Program** — the bot is useless without it
- **Weight Formatting** — always the same content (copy verbatim)
- **Structure** — the bot needs to know the split

## Worked Example

The current `config/program.md` is a 5/3/1 Upper/Lower split. Read it for:
- Appropriate level of detail (percentage tables, not theory)
- How "Determining Where I Am" maps history to program state
- How warmup sets are described with plate math
- How supplemental and accessory guidelines stay practical
