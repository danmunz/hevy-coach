# Equipment Output Template

ALWAYS use this section structure when generating `config/equipment.md`:

```markdown
# [Name]'s [Gym Type]

**All weights below in lbs.**

## Barbell & Rack
- [Rack type and model if known]
- [Barbell type(s)]
- [Bench type: flat, adjustable incline, decline]
- [Plate inventory with quantities: e.g., 4x45, 2x25, 4x10, 2x5, 2x2.5]
- [Cable/pulley system if rack-mounted]
- [Cable attachments list]

## Dumbbells
- [Type: fixed pairs (list weights), adjustable (weight range), or none]

## Other Equipment
- [Pull-up bar, dip station, kettlebells (list weights), bands, ab wheel, etc.]

## Constraints
- [No spotter, low ceiling, noise restrictions, no machines, etc.]
- All weights prescribed and displayed in lbs
```

## Formatting Rules

- Use bullets, not prose. The coach scans this for exercise selection.
- Group by category with H2 headers.
- List plates with quantities — the coach needs this for warmup math.
- All weights in lbs. If the user gives kg, convert and note it.
- Target 25-40 lines (~400 tokens). This file should be the shortest config.
- End with a Constraints section even if minimal.

## Commercial Gym Variant

For commercial gym users, simplify the template:

```markdown
# [Name]'s [Gym Name/Type]

**All weights below in lbs.**

## Available Equipment
- Full free weight area (barbells, dumbbells up to [X] lbs, plates)
- [Notable machines they'd use: cable crossover, leg press, etc.]
- [Specialty equipment: trap bar, SSB, GHD, etc.]

## Notable Gaps or Preferences
- [Anything missing or avoided]

## Constraints
- [Time restrictions, crowded hours, etc.]
```

No plate inventory needed — commercial gyms have standard plates.

## Worked Example

The current `config/equipment.md` is a home gym setup. Read it for a
concrete example of appropriate length and detail level.
