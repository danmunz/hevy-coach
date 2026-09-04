# AGENTS.md — Development Guidelines & Standards

This document defines the operational standards, workflow policies, and engineering discipline expected from all contributors — both AI agents and human developers — working on **hevy-coach**.

---

## 1. Git Workflow & Version Control

### 1.1 Atomic Commits
- **Single Responsibility**: Every commit MUST represent a single, self-contained logical change (e.g., fixing the exercise template caching, updating a config file, adding a new tool definition).
- **No Kitchen-Sink Commits**: Never mix refactoring, formatting changes, and new features in the same commit.
- **Build Integrity**: The codebase MUST pass `npx tsc --noEmit` at every commit in the history.

### 1.2 Commit Message Format
All commit messages MUST follow the **Conventional Commits** specification:

```text
<type>(<scope>): <short imperative summary>

[optional body explaining WHY and WHAT]

[optional footer(s), e.g., Fixes #123]
```

#### Allowed Types
- `feat`: A new feature or capability.
- `fix`: A bug fix.
- `docs`: Documentation changes only (`README`, specs, code comments).
- `style`: Formatting, whitespace changes (no logic change).
- `refactor`: Code change that neither fixes a bug nor adds a feature.
- `test`: Adding missing tests or correcting existing tests.
- `chore`: Maintenance tasks, dependency updates, build configuration.
- `perf`: Code changes that improve performance.

#### Examples
- `feat(hevy): add cached exercise template fetching`
- `fix(claude): store user message in max-iterations fallback path`
- `docs(readme): add customization guide for config files`
- `refactor(telegram): simplify HTML sanitizer with placeholder technique`

---

## 2. Branching Strategy

- **`main`**: Production-ready branch. Should always be deployable.
- **Feature Branches**: `feat/<short-description>` (e.g., `feat/streaming-responses`)
- **Bugfix Branches**: `fix/<short-description>` (e.g., `fix/html-tag-splitting`)

---

## 3. Test & Verification Discipline

### 3.1 Verification Standards
- **Type checking**: Run `npx tsc --noEmit` before committing. Zero errors required.
- **Manual smoke test**: After changes to the Claude tool loop, Hevy client, or Telegram transport, verify with `npm run chat` (CLI) or a live Telegram message before considering the change complete.
- **Exercise pin resolution**: After modifying `exercise-pins.ts` or `client.ts` template fetching, run `npm run setup` to verify all pins resolve.

### 3.2 Verification Discipline
- **No Unverified Declarations**: Never claim a task or feature is complete without running the type checker and, for behavioral changes, testing the affected flow.
- **No Masking Errors**: Do not write empty `catch` blocks that swallow errors silently, lower type strictness to pass the build, or return error objects where exceptions should propagate. Fix the underlying root cause.

---

## 4. Documentation Hygiene

### 4.1 Zero README Setup Drift
- Update [`README.md`](README.md) whenever a change modifies developer setup, prerequisites, environment variables, dependencies, npm scripts, or run procedures.
- Do not let instructions in `README.md` fall out of sync with actual codebase requirements.

### 4.2 Config File Documentation
- The four config files in `config/` (`coach.md`, `equipment.md`, `program.md`, `defaults.json`) are the primary customization surface. When changing what these files control or how they're consumed by `src/claude/context.ts`, update the README's customization section.

### 4.3 Code Review Records
- Store code review findings in `docs/review-*.md` with date, scope, severity ratings, and fix verification.
- Reference review findings by ID (e.g., `CRIT-001`, `IMP-003`) in commit messages when addressing them.

---

## 5. Architecture & Design Constraints

### 5.1 Single-User, Single-Process Design
This is a personal bot for one lifter. Design decisions should optimize for simplicity and reliability, not scalability:
- No authentication system beyond the `AUTHORIZED_CHAT_ID` check.
- No database migrations framework — the schema is simple enough to manage directly.
- No abstraction layers beyond what's needed. Prefer direct function calls over plugin systems.

### 5.2 Separation of Concerns
The codebase has four clear layers. Respect the boundaries:
- **`config/`** — User-facing customization. Markdown and JSON only. No code.
- **`src/state/`** — SQLite persistence. Pure data access, no business logic.
- **`src/hevy/`** — Hevy API client. Handles HTTP, retries, normalization. No Claude or Telegram awareness.
- **`src/claude/`** — Claude integration. Assembles context, defines tools, runs the tool loop. No direct Telegram awareness.
- **`src/telegram/`** — Telegram transport. Message formatting and sending. No Claude or Hevy awareness.
- **`src/index.ts`** — Wires the layers together. Minimal logic.

### 5.3 Direct HTTP Over Abstractions
The Hevy client uses raw `fetch` with an `api-key` header. This is intentional — no MCP transport, no SDK wrappers, no HTTP client libraries. The retry logic, pagination, and response normalization live in one file (`src/hevy/client.ts`). Keep it that way.

### 5.4 Weight Handling
All weights in user-facing code, config files, tool schemas, and Claude conversations are in **pounds**. Conversion to kilograms happens at the Hevy API boundary only, using `poundsToRoundedKilograms()` with 0.001 kg precision. This preserves clean round-number lb display in the Hevy app. Never store or display kg values internally.

---

## 6. Code Hygiene & Security Standards

### 6.1 Type Safety
- TypeScript strict mode is enabled. Keep it that way.
- Suppressing type checks (`@ts-ignore`, `as any`) is prohibited unless accompanied by an inline comment explaining why it's unavoidable.
- Hevy API responses use defensive normalization (checking both camelCase and snake_case field names) because the API's casing is inconsistent across endpoints.

### 6.2 Zero Secrets in Git
- Never commit API keys, bot tokens, or chat IDs to Git.
- `.env` is gitignored. `.env.example` contains only placeholder values.
- The `.env` file contains real credentials — treat it accordingly. If you see secrets in staged changes, unstage them immediately.

### 6.3 No Leftover Debugging Artifacts
- Clean up `console.log` calls that aren't prefixed with a tag (`[hevy]`, `[claude]`, `[tool]`, `[telegram]`, `[fatal]`).
- No commented-out code blocks, no `TODO` comments without an accompanying explanation, no scratch files.

### 6.4 Error Handling Layers
The bot has three error boundaries. Preserve this structure:
1. **Tool executor** — catches tool-level errors and returns them as conversational strings (Claude can explain the failure to the user).
2. **Chat function** — catches Claude API and tool loop errors.
3. **Telegram handler** — catches everything else and sends a fallback "Something went wrong" message.

Errors should be caught at the narrowest appropriate boundary. Don't catch at the Telegram layer what should be caught at the tool layer.

---

## 7. Claude Integration Standards

### 7.1 Tool Definitions
- Tool descriptions in `src/claude/tools.ts` are part of the prompt. Write them as instructions to Claude, not as API documentation.
- All weights in tool schemas are in pounds (`weight_lbs`). The tool executor handles conversion.
- Required fields must be marked with `required` in the schema. Claude respects these.

### 7.2 System Prompt Assembly
- The system prompt is assembled fresh on every message from config files + SQLite state.
- Config files are read from disk, not cached — so edits take effect on the next message.
- Keep the total system prompt under ~4000 tokens. Bloated prompts increase cost and reduce response quality.

### 7.3 Chat History
- Messages are stored AFTER Claude responds successfully (both user and assistant together). This prevents consecutive same-role messages in the database if the API call fails mid-flight.
- `sanitizeHistory()` is a belt-and-suspenders defense against DB corruption. It should never actually need to merge messages in normal operation.

---

## 8. Customization Surface Contract

The following files are the intended customization surface for end users. Changes to how these files are consumed must preserve backward compatibility or be documented as breaking:

| File | Format | Hot-reload? | What it controls |
|---|---|---|---|
| `config/coach.md` | Markdown | Yes (next message) | Coach persona, voice, style, adjustment logic (swappable) |
| `config/rules.md` | Markdown | Yes (next message) | Behavioral guardrails: safety rules, tool usage protocols (stable across personas) |
| `config/equipment.md` | Markdown | Yes (next message) | Available gym equipment and constraints |
| `config/program.md` | Markdown | Yes (next message) | Training program structure, progression, percentages |
| `config/defaults.json` | JSON | No (setup only) | Initial training maxes and goals |
| `src/hevy/exercise-pins.ts` | TypeScript | No (setup + restart) | Exercise name to Hevy template ID mappings |
| `.env` | Dotenv | No (restart required) | API keys, model, timezone, authorized user |

"Hot-reload" means the file is read from disk on every incoming message, so edits take effect without restarting the bot.
