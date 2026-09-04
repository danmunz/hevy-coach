---
name: setup-equipment
description: >
  Generate config/equipment.md through a guided conversation — the gym inventory
  file that tells the coach what exercises are available. Use when the user says
  /setup-equipment, "set up my equipment," "set up my gym," "what equipment,"
  "I got new equipment," or wants to update their gym inventory. Supports photo
  analysis and manual walk-through. Handles home gyms, commercial gyms, and
  minimal setups.
---

# Setup Equipment

Generate `config/equipment.md` — the gym inventory. Hot-reloaded on every
message. The coach uses this to pick exercises the user can actually do.
Target 25-40 lines, bullets not prose. All weights in lbs.

## Workflow

1. **Check for existing file**

   Read `config/equipment.md`.
   - **File exists?** → "I see you already have an equipment list. Want to
     update it, or start fresh?" If updating, read the file and ask what changed.
   - **No file?** → Proceed with full flow.

2. **Gym type**

   Ask (multiple choice): "What kind of gym setup do you have?"
   - Home gym (garage/basement/spare room)
   - Commercial gym membership
   - Apartment / minimal space
   - Hotel / travel setup
   - Mix (home + commercial)

   This determines the depth of the walk-through.

3. **Photo option**

   "Want to share a photo of your gym? I can identify equipment from it and
   you just confirm. Or we can walk through it manually."

   - **Photo provided** → Analyze the image, list what's visible, ask the user
     to confirm and fill gaps ("I can see a power rack and what looks like a
     flat bench. Is that adjustable? What plates do you have?")
   - **No photo** → Proceed to manual walk-through.

4. **Equipment walk-through**

   Ask one category at a time. Do not dump all questions at once.

   **Home gym / apartment / minimal**:

   Barbell & Rack:
   - "What kind of rack? Power rack, squat stand, half rack, or none?"
   - "Standard Olympic barbell? Any specialty bars (trap bar, EZ curl, etc.)?"
   - "Bench — flat only, adjustable incline, or adjustable with decline?"
   - "List your plate inventory (e.g., 4x45, 2x25, 4x10, 2x5, 2x2.5).
     This helps the coach program accurate warmup sets."

   Cables/Machines:
   - "Any cable or pulley system? What attachments?"

   Dumbbells:
   - "Dumbbells — fixed pairs (list weights), adjustable (weight range), or none?"

   Other:
   - "Pull-up bar? Dip station? Kettlebells (list weights)? Bands? Ab wheel?
     Anything else?"

   **Commercial gym**:
   - "Since you're at a commercial gym, I'll assume standard equipment
     (barbells, full dumbbell rack, plate-loaded machines, cables). Anything
     notably missing or any specialty equipment worth mentioning?"

5. **Constraints**

   "Any constraints I should know about? (e.g., no training partner/spotter,
   low ceiling, noise restrictions, shared space, limited time slots)"

6. **Generate output**

   Read `references/equipment-template.md` for the exact section structure.
   Generate `config/equipment.md` following that template.

   If the user provided weights in kg, convert to lbs and note it.

   Read the existing `config/equipment.md` (if present) as a worked example
   of appropriate length and detail.

7. **Confirm or refine**

   Show the generated file. "How does this look? Anything to add or change?"
   Loop until approved. Write `config/equipment.md`.

8. **Next steps**

   "Your equipment list is saved. It takes effect on the next message. If you
   haven't set up your coach persona or program yet, run `/setup-coach` or
   `/setup-program`."
