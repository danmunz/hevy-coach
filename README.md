# hevy-coach

![hevy-coach](assets/coach-hevy.png)

A Telegram bot that acts as your personal strength coach. It reads your training history from [Hevy](https://hevy.com), generates daily workouts using Claude, and pushes approved routines back into the Hevy app — so you wake up, text "morning," and get a personalized workout ready to start.

## Why this exists

Programming a 5/3/1 workout every morning is tedious: look up your training maxes, calculate percentages, figure out where you are in the cycle, pick accessories that match your equipment and how you're feeling. This bot does all of that. It knows your gym, your program, your history, and your goals. It asks how you're feeling before it programs anything, adjusts on the fly, and pushes the result straight into your workout tracker.

It's a single-user bot — one coach, one lifter, one Telegram chat.

## What a conversation looks like

```
You:    morning
Coach:  Morning. Squat day, 3s week. You've been on a tear this
        week — three sessions already. How's the body holding up?

You:    good, slept well, let's go

Coach:  Squat Day: Peer-Reviewed Pain

        Warmup
        Squat — bar×10, 95×5, 135×3

        Main Work (3s week)
        Squat — 145×3, 165×3, 185×3

        Accessories
        Front Squat — 95×8 ×3
        Hanging Knee Raise — BW×12 ×3 (superset)
        Cable Crunch — 50×15 ×3
        Lat Pulldown — 90×12 ×3

        Ship it?

You:    ship it

Coach:  Done — "Peer-Reviewed Pain" is loaded in Hevy. Go get it.

You:    actually swap front squats for KB swings

Coach:  Swapped. 53 lb KB, 15 reps × 3 sets. Updated in Hevy.
```

## Prerequisites

- **Node.js 18+** (tested on 20 and 22)
- **Telegram Bot Token** — create a bot via [@BotFather](https://t.me/BotFather) on Telegram
- **Anthropic API Key** — from [console.anthropic.com](https://console.anthropic.com)
- **Hevy API Key** — requires a Hevy Pro subscription; find it at [hevy.com/settings](https://hevy.com/settings) under API
- **Your Telegram Chat ID** — message [@userinfobot](https://t.me/userinfobot) on Telegram to get it

## Setup

```bash
# Clone and install
git clone <repo-url>
cd hevy-coach
npm install

# Configure
cp .env.example .env
# Edit .env and fill in all values (see below)

# First-run setup — creates the database, verifies all 3 APIs,
# and caches exercise template mappings from Hevy
npm run setup

# Test in the terminal before going live on Telegram
npm run chat
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `HEVY_API_KEY` | Yes | Hevy API key (Pro subscription required) |
| `AUTHORIZED_CHAT_ID` | Yes | Your Telegram chat ID — only this user can talk to the bot |
| `CLAUDE_MODEL` | No | Claude model to use (default: `claude-sonnet-5`) |
| `TIMEZONE` | No | Your timezone for local time display (default: `America/New_York`) |
| `HEVY_SYNC_INTERVAL_SECONDS` | No | Background workout check interval in seconds (default: `300`). Set to `0` to disable background checks. Each coaching turn still checks Hevy. |

### What `npm run setup` does

1. Creates `data/hevy-coach.db` (SQLite, WAL mode) with tables for chat history, config, notes, and exercise mappings
2. Seeds default training maxes and goals from `config/defaults.json`
3. Verifies your Telegram bot token, Anthropic API key, and Hevy API key are valid
4. Fetches the exercise template catalog from Hevy and resolves the configured exercise pins to template IDs

If any API verification fails, setup tells you which one and stops. Fix the key in `.env` and re-run — setup is idempotent.

## Running

After setup completes, you have three ways to run the bot. Start with the CLI to verify everything works before going live on Telegram.

### 1. Test in the terminal first

```bash
npm run chat
```

Opens an interactive REPL that talks to Claude with the full tool loop — same brain as the Telegram bot, just in your terminal. It starts from a temporary SQLite backup, so chat history, notes, and training-max updates can be exercised without changing the production database. It can make live Hevy **read** calls, but blocks all Hevy routine writes. The temporary state is deleted when the REPL exits.

### 2. Run the Telegram bot (foreground)

```bash
npm start
```

Starts the Telegram bot in the foreground. Text your bot on Telegram — it should respond. Ctrl+C to stop.

### 3. Run with pm2 (production — optional)

`npm start` works fine, but it ties up a terminal window and dies if you close it or your machine sleeps and the shell is reaped. [pm2](https://pm2.keymetrics.io/) is a Node.js process manager that runs the bot as a background daemon — it keeps running after you close the terminal, auto-restarts on crashes, and writes logs to files instead of stdout.

You don't need pm2 if you're just trying the bot out. It's worth setting up once you want the bot to be always-on — text it at 6am and it's already running.

```bash
# Install pm2 globally (one-time)
npm install -g pm2

# Start the bot as a managed background process
npm run pm2:start

# View logs (streaming, Ctrl+C to stop watching)
npm run pm2:logs

# Restart after code or environment changes
npm run pm2:restart

# Stop the bot
npm run pm2:stop

# Check if it's running
npm run pm2:status
```

What pm2 adds:

- **Auto-restart on crash** — if the bot hits an unhandled exception, pm2 restarts it after a 5-second delay (up to 10 consecutive restarts before giving up)
- **Memory guard** — restarts the process if it exceeds 256MB, which prevents slow leaks from accumulating
- **Log files** — stdout and stderr go to `logs/out.log` and `logs/error.log` with timestamps, so you can debug issues after the fact
- **Background execution** — the bot runs as a daemon; closing your terminal doesn't kill it

The pm2 config lives in `ecosystem.config.cjs`. The `cwd` path in that file is hardcoded to the project directory — if you move the project, update it there.

The host must remain awake for coaching and background checks to run. PM2 does not prevent laptop sleep.

## Repository structure

```
hevy-coach/
├── config/                  # ← EDIT THESE to customize the bot
│   ├── coach.md             #   Coach persona, voice, style (swappable)
│   ├── rules.md             #   Behavioral guardrails (stable across personas)
│   ├── equipment.md         #   Your gym inventory and constraints
│   ├── program.md           #   Training program structure
│   └── defaults.json        #   Initial training maxes and goals
│
├── src/
│   ├── index.ts             # Entry point: Telegram bot setup, auth gate, message handler
│   ├── telegram/
│   │   ├── client.ts        # HTML sanitization, message splitting, send helpers
│   │   └── handler.ts       # Ordered coaching and delivery
│   ├── coach/              # Workout synchronization and checked context
│   ├── claude/
│   │   ├── client.ts        # Core chat() function: Claude API + tool execution loop
│   │   ├── context.ts       # System prompt assembly from config files + DB state
│   │   ├── tools.ts         # 8 tool definitions (Hevy read/write, notes, config)
│   │   └── tool-executor.ts # Tool dispatch: calls Hevy client, manages state
│   ├── hevy/
│   │   ├── client.ts        # Hevy REST API client (direct HTTP, retry, pagination)
│   │   ├── exercise-pins.ts # Exercise name → Hevy template ID resolution
│   │   ├── summarize.ts     # Compact workout summaries for Claude's context
│   │   ├── types.ts         # TypeScript types for Hevy API responses
│   │   └── utils.ts         # Weight conversion and text normalization
│   └── state/
│       ├── db.ts            # SQLite connection (lazy singleton, WAL mode)
│       ├── chatlog.ts       # Chat history storage and retrieval
│       ├── config.ts        # Key-value config (training maxes, goals)
│       ├── notes.ts         # Persistent coaching notes (injuries, preferences)
│       ├── workouts.ts      # Workout cache and synchronization checkpoint
│       └── routine-state.ts # Confirmed and pending routine writes
│
├── scripts/
│   ├── setup.ts             # First-run setup (DB, API verification, template cache)
│   └── chat.ts              # CLI chat REPL for testing
│
├── data/                    # Created at runtime — gitignored
│   └── hevy-coach.db        # SQLite database
├── logs/                    # pm2 log output — gitignored
│
├── .claude/skills/          # Claude Code setup skills (/setup-coach, etc.)
├── docs/                    # Design docs and code reviews
├── ecosystem.config.cjs     # pm2 process config
├── .env                     # Your API keys — gitignored
├── .env.example             # Template for .env
├── package.json
└── tsconfig.json
```

## Customizing the bot for yourself

The bot is designed so that everything personal lives in a few clearly separated files. You should never need to touch `src/` to make it your own coach.

**Guided setup**: If you're using [Claude Code](https://claude.com/claude-code), three setup skills walk you through generating these files interactively:
- `/setup-coach` — builds your coach persona through a conversation
- `/setup-equipment` — inventories your gym (supports photo analysis)
- `/setup-program` — configures your training program and starting weights

You can also edit the files directly — they're just markdown.

### 1. Coach persona (`config/coach.md`)

This is the system prompt that defines who the coach *is* — their personality, voice, and coaching style. The default is an evidence-based Jeff Nippard-style coach. You can change:

- **Voice and personality** — make it a drill sergeant, a yoga instructor, a bodybuilding bro, whatever you want
- **Morning check-in style** — how the coach opens a conversation, what kind of openers it rotates between
- **Programming philosophy** — what the coach prioritizes (hypertrophy, strength, both)
- **Adjustment logic** — what happens when you're tired, short on time, or hurting
- **Routine naming style** — the fun titles it gives workouts in Hevy
- **Example exchanges** — few-shot examples that set the tone for Claude's responses

The persona file is loaded fresh on every message, so changes take effect immediately (no restart needed).

Behavioral rules (when to save notes, how to handle TM updates, safety guardrails) live separately in `rules.md` — so you can swap personas without losing guardrails.

### 2. Coaching rules (`config/rules.md`)

Behavioral guardrails that apply regardless of which persona you're using. These control *what the coach must and must not do*, not how it sounds doing it:

- **Check-in before programming** — never dump a workout without asking how the user feels
- **Overwrite protection** — check for unfinished routines before replacing them
- **Notes management** — save notes autonomously, clear when resolved
- **TM update protocol** — never update training maxes without explicit confirmation
- **API failure handling** — graceful degradation when Hevy is down
- **Hard constraints** — never prescribe unavailable equipment, never ignore pain

Most users won't need to edit this file. It's separated from the persona so that swapping `coach.md` doesn't accidentally remove a safety rule.

Loaded fresh on every message, same as the persona.

### 3. Equipment list (`config/equipment.md`)

Your gym. The coach uses this to pick exercises you can actually do. List everything you have — barbells, dumbbells, machines, cables, bands, whatever. Note constraints like "no spotter" or "low ceiling."

All weights should be written in lbs. The bot converts to kg at the API boundary using high-precision conversion (0.001 kg) so Hevy displays clean round-number lbs.

### 4. Training program (`config/program.md`)

The structure of your program. The default is a 5/3/1 Upper/Lower split, but you can replace this with any program:

- **Split structure** — what days train what
- **Progression scheme** — how weights increase over time
- **Set/rep schemes** — what the working sets look like
- **Supplemental and accessory guidelines** — volume targets, exercise selection rules
- **How to determine program state** — the bot reads your Hevy history to figure out where you are in the program; describe how that mapping works

If you change the program structure significantly (e.g., from 5/3/1 to a PPL split), you'll also want to update the exercise pins (see below).

### 5. Starting values (`config/defaults.json`)

Initial training maxes and goals, seeded into SQLite on first `npm run setup`. After setup, the bot manages these values itself (Claude updates them via tools when you confirm changes), so editing this file only matters before the first run or if you delete the database.

```json
{
  "training_maxes": "{\"squat\": 205, \"bench\": 155, \"deadlift\": 275, \"ohp\": 95}",
  "goals": "Preserve muscle during cut, maintain or slowly progress strength"
}
```

### 6. Exercise pins (`src/hevy/exercise-pins.ts`)

Edit the `EXERCISE_PINS` map in this file to associate exercise names with Hevy search queries. Setup resolves those queries to template IDs.

If your program uses exercises not in the default pin list (e.g., you do Romanian Deadlifts, Hip Thrusts, or machine exercises), add them here:

```typescript
"Romanian Deadlift": { query: "Romanian Deadlift (Barbell)" },
"Hip Thrust":        { query: "Hip Thrust (Barbell)", primaryMuscleGroup: "glutes" },
```

The `query` is what to search for in Hevy's exercise library. The optional `primaryMuscleGroup` narrows results when the query is ambiguous. After editing, re-run `npm run setup` to resolve the new pins.

For an unpinned exercise, the bot searches the catalog for a unique exact or word-order match. It rejects uncertain matches instead of substituting equipment.

### 7. Environment variables (`.env`)

`CLAUDE_MODEL` selects the model. The default is `claude-sonnet-5`.

`TIMEZONE` affects the local time shown in the system prompt, which helps the coach know if it's morning, afternoon, or late at night.

Restart the bot after changing `.env`. The Markdown files in `config/` reload on each message.

## How it works under the hood

1. **You text the bot** on Telegram. The bot only responds to your `AUTHORIZED_CHAT_ID`; all other messages are silently ignored.

2. **Hevy context is checked** for workout changes and the standing routine. Background checks also run about every five minutes. Failed checks are marked unavailable.

3. **Claude receives checked context** with config files, training maxes, notes, recent chat history, and the current time. Static instructions use prompt caching. Tools provide additional details when needed.

4. **Tool loop** runs up to 10 iterations. When Claude calls a tool (e.g., `hevy_push_routine`), the tool executor dispatches it, returns the result, and Claude continues. The loop ends when Claude produces a text response.

5. **The response is formatted for Telegram** and split into balanced HTML chunks near 2,000 visible characters. There is no fixed pause between parts.

6. **Turns run in order**, including delivery. Each turn has a 75-second budget. Delivery also has a 30-second limit. A failure notice gets up to five extra seconds. Uncertain sends do not retry automatically.

7. **Chat history is stored** in SQLite after a successful response. Both the user message and assistant response are stored together to prevent database corruption.

### Tools Claude can use

| Tool | What it does |
|---|---|
| `hevy_get_recent_workouts` | Fetch and summarize recent completed workouts |
| `hevy_get_exercise_history` | Get progression history for a specific exercise over the last 90 days by default, or an explicit date interval |
| `hevy_get_routines` | List saved routines or read one routine's complete sets |
| `hevy_push_routine` | Create or update the standing routine in Hevy |
| `hevy_edit_routine_exercise` | Swap one exercise in the current routine |
| `save_note` | Save a persistent note (injury, preference, schedule) |
| `clear_note` | Deactivate a note that's no longer relevant |
| `update_training_maxes` | Update training maxes after user confirmation |

### Data storage

All persistent state lives in `data/hevy-coach.db` (SQLite, WAL mode):

- **messages** — chat history (role, content, timestamp). Limited to last 30 messages / 48 hours for Claude's context window.
- **config** — key-value pairs (training maxes, goals). Updated by Claude via tools.
- **notes** — coaching notes with soft-delete. Claude saves and clears these autonomously.
- **exercise_map** — cached exercise name → Hevy template ID mappings. Populated by `npm run setup`.
- **pending_hevy_mutation** — a routine write whose remote result is unknown. It blocks later routine writes until you inspect and resolve the outcome.
- **workout_cache / workout_checkpoint** — up to ten recent workouts and the last successful scan time. Full refreshes run at startup and at least hourly when scans succeed.

To reset everything and start fresh, delete `data/hevy-coach.db` and re-run `npm run setup`.

## Cost

Claude API usage is billed separately from Hevy Pro. Cost depends on the model, conversation history, output length, and prompt-cache use. Setup verification and CLI chat also call Claude. Background workout checks call Hevy only.

## Troubleshooting

**Setup hangs or fails on exercise template resolution**
Check your Hevy API key. Setup fetches the exercise catalog across multiple pages. Invalid keys and rate limits can prevent completion.

**Bot doesn't respond on Telegram**
Verify `AUTHORIZED_CHAT_ID` matches your actual Telegram chat ID (it's a number, not your username). Check `npm run pm2:logs` for errors.

**Claude uses wrong exercises or weights**
Check `config/program.md` — that's where the set/rep schemes and percentage calculations are defined. Also verify your training maxes are correct: they're stored in SQLite after the first setup and managed by Claude thereafter.

**Routine doesn't appear in Hevy**
Check your Hevy Pro subscription and API key. Look for `[tool]` outcome entries in the PM2 logs.

**The coach says a previous routine write has an unknown outcome**
Do not resend the workout immediately. Check the standing routine in Hevy first: an interrupted request may have completed remotely. The bot blocks a second routine write to avoid creating a duplicate or overwriting an unknown result. Clear the pending record only after reconciling the intended routine with what is in Hevy.

To reconcile a pending update, the recovery command fetches the routine again
and clears the block only when its programming fields match the pending payload:

```bash
npm run recover:hevy
```

For an interrupted create, first find the candidate routine's ID in Hevy, then
provide it explicitly:

```bash
npm run recover:hevy -- --routine-id <id>
```

The command makes a single read request. It never retries the interrupted write
and leaves the safety block in place if the remote routine does not match.

**Workout freshness check fails**
Check for new `[sync] scan_failed` entries in `logs/error.log`. Failed scans preserve the previous cache and checkpoint. Later scans retry.

**A reply is incomplete or times out**
Check `[delivery]` entries for the number of confirmed parts. A failed reply does not mean a Hevy write failed. Check Hevy before repeating a change request.

## Development

Run the local checks before contributing:

```bash
npx tsc --noEmit
npm run typecheck
npm test
```

These checks use local fixtures and do not require paid model calls. Logs identify each turn and record context time, model usage, tool outcomes, and delivery progress.

Technical decisions and verification results live in [docs/](docs/). The [performance review](docs/review-sprint-closure-2026-09-07.md) records the synchronization, context, and delivery changes.
