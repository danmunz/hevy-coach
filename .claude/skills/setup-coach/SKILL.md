---
name: setup-coach
description: >
  Generate config/coach.md through a guided conversation — the coach persona
  file that controls voice, style, and coaching philosophy. Use when the user
  says /setup-coach, "set up my coach," "change coach persona," "I want a
  different coach," "customize the coach," or wants to refine the existing
  persona. This skill walks through persona selection, philosophy, and voice
  to produce a complete coach.md that the bot hot-reloads on every message.
---

# Setup Coach

Generate `config/coach.md` — the swappable persona file that controls who the
coach *is* (voice, philosophy, style). Hot-reloaded on every message, no restart
needed. Behavioral rules (what the coach must/must not do) live separately in
`config/rules.md` and are NOT touched by this skill.

## Workflow

1. **Check for existing file**

   Read `config/coach.md`.
   - **File exists?** → "I see you already have a coach persona. Want to refine
     it, or start fresh?" If refining, read the file and ask what to change.
   - **No file?** → Proceed with full flow.

2. **Who is the coach?**

   Ask one question: "Who should your coach be? This can be a recognized fitness
   figure (Jeff Nippard, Mark Rippetoe, Mike Israetel, Dan John, etc.), a real
   person you know, or a character you invent."

3. **Determine path**

   - **Recognized fitness figure?** → Follow "Recognized path" below
   - **Custom or unknown person?** → Follow "Custom path" below

### Recognized path

Synthesize their *substantive views* — not just their vibe. Cover:
- Programming approach (LP? periodization? volume-driven? intensity-driven?)
- Stance on accessories (minimal? extensive? programmed or autoregulated?)
- Core/ab training philosophy
- Deload protocols (scheduled? by feel?)
- RPE vs. percentage-based programming
- Machine vs. free weight preference
- How they handle injuries/pain
- How they handle bad days
- Communication quirks (Rippetoe's bluntness, Israetel's scientific humor,
  Nippard's evidence-based enthusiasm, Dan John's park bench analogies)

Present a 3-5 bullet summary of their philosophy for confirmation:
"Here's what I know about [Name]'s approach. Does this match?"

Ask 1-2 clarifying questions only where views are genuinely ambiguous
(e.g., "Rippetoe is anti-accessories, but some SS coaches include them.
Strict or flexible?").

### Custom path

Ask 4-5 questions across two rounds. Do not ask all at once.

**Round 1** (philosophy):
- "What's their training priority? Strength, hypertrophy, balanced, sport-specific,
  or general fitness?"
- "How do they handle bad days — tired, sore, short on time? Push through,
  autoregulate, or skip?"

**Round 2** (style):
- "How do they feel about accessory work? Minimal, moderate, or extensive?"
- "What's their communication style? Brief and direct, chatty, drops science,
  uses humor, tough love?"
- "Anything specific they should always or never do?"

**Defaults**: For any skipped question, fill reasonable defaults based on the
person's role (gym teacher → balanced/encouraging, personal trainer →
client-focused/flexible). State your assumptions: "I'll fill in my best guess
— you can always edit coach.md later."

4. **Generate output**

   Read `references/coach-template.md` for the exact section structure.
   Generate the full `config/coach.md` following that template.

   The Example Exchanges section must contain 3 dialogue pairs demonstrating
   the persona's actual voice in realistic coaching situations (morning greeting,
   user pushback, user achievement).

   Read the existing `config/coach.md` (if present) as a worked example of
   appropriate length and detail.

5. **Confirm or refine**

   Show the generated file to the user.
   "How does this look? I can adjust the voice, change the philosophy, or
   tweak any section."

   Loop until the user approves. Then write `config/coach.md`.

6. **Next steps**

   "Your coach persona is saved. It takes effect on the next message to the
   bot (no restart needed). If you haven't set up your equipment or program
   yet, run `/setup-equipment` or `/setup-program`."

## Mandatory Elements

These MUST appear in every generated `coach.md`, in the Voice & Style section:
- Format messages for Telegram using HTML. Use `<b>bold</b>` for exercise names.
- Keep messages conversational — you're texting, not writing a document.
- Never say "I'm just an AI" — you're their coach.
- Stay in character.
