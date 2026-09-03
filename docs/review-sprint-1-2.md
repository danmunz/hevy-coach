# Code Review: Sprints 1 + 2

**Date**: 2026-09-03
**Scope**: All source code in `src/`, `scripts/`, config files
**Spec reference**: `docs/hevy-coach-spec-final.md`

---

## Summary

- **Critical**: 2 issues (must fix before Sprint 3)
- **Important**: 6 issues (should fix before Telegram goes live)
- **Suggestion**: 4 items (improve later)
- **Weight conversion**: Verified correct. 135 lbs -> 61.235 kg, round-trips cleanly.
- **Spec alignment**: Good. Implementation matches spec closely with two deviations (see SPEC-001 and SPEC-002).

---

## Critical

### CRIT-001: Consecutive user messages after a crash break the chat permanently

**Files**: `src/claude/client.ts` lines 29-35

The `chat()` function stores the user message in SQLite *before* calling Claude:

```typescript
// Line 30: stored immediately
addMessage('user', userMessage);

// Line 35: history loaded, now includes the message we just stored
const chatHistory = loadChatHistory();
```

If the Claude API call, tool execution, or anything in the loop throws after this point (network timeout, Hevy API hang, process crash), the user message is persisted but no assistant message follows. On the next call, `addMessage('user', ...)` stores another user-role message, creating consecutive `user` entries in the `messages` table.

The Anthropic Messages API rejects non-alternating roles. Once this happens, every subsequent `chat()` call throws a validation error, and the bot is permanently stuck until someone manually edits the database.

The spec explicitly says both messages should be stored after the response (step 9 in "Context Loading Per Request"), not before.

**Fix**: Store the user message after Claude responds successfully, and pass it into the messages array directly:

```typescript
export async function chat(userMessage: string): Promise<string> {
  const systemPrompt = assembleSystemPrompt();
  const chatHistory = loadChatHistory();

  // Build messages from history + current (not yet persisted)
  const messages: Anthropic.MessageParam[] = [
    ...chatHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userMessage },
  ];

  // ... tool loop ...

  // Store BOTH after success
  addMessage('user', userMessage);
  addMessage('assistant', finalText);

  return finalText;
}
```

Alternatively, add a history sanitizer that drops or merges consecutive same-role messages before sending to Claude. This is the belt-and-suspenders approach for a long-running bot.

---

### CRIT-002: Exercise template search only checks 30 templates

**File**: `src/hevy/client.ts` lines 532-594 (`searchExerciseTemplates`)

The method fetches from the listing endpoint `/exercise_templates?page=N&pageSize=10` and does client-side substring matching, but caps at 3 pages (30 templates). Hevy's built-in library has hundreds of exercise templates. If the desired exercise template falls outside the first 30 returned by the API, it will never be found.

This affects both:
- **Setup** (`resolveExerciseMap`): pins may fail to resolve, logging a warning and leaving the exercise un-cached
- **Runtime** (fuzzy search fallback in `resolveExerciseName`): Claude says "Squat" but the server can't find the Hevy template, returning an error to the user

```typescript
// Line 533: only searches 3 pages
while (page <= 3) {
```

**Fix**: Either:
1. Paginate through all available pages (check `pageCount` from the response), or
2. Increase the page limit significantly (e.g., 20 pages = 200 templates), or
3. Use a larger `pageSize` (the Hevy API may support up to 100 per page -- test this)

Option 1 is the most correct. The search is called infrequently (setup + rare runtime fallback), so the extra API calls are acceptable:

```typescript
while (true) {  // iterate all pages
  const payload = await this.fetchJson<Record<string, unknown>>(
    `/exercise_templates?page=${page}&pageSize=${pageSize}`,
  );
  // ... existing filtering logic ...

  const pageCount = /* extract from payload */;
  if (page >= pageCount) break;
  page++;
}
```

---

## Important

### IMP-001: Tool loop stop condition could silently drop tool calls

**File**: `src/claude/client.ts` line 70

```typescript
if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
```

The `||` means: if `stop_reason` is `'end_turn'` and there ARE tool_use blocks in the response, the tool calls are silently ignored and only the text content is extracted. While the current Anthropic API pairs `stop_reason: 'tool_use'` with tool_use blocks (not `'end_turn'`), this condition is wrong directionally -- it fails open instead of failing safe.

**Fix**: Check the canonical signal for tool use:

```typescript
if (response.stop_reason !== 'tool_use') {
```

Or simply:

```typescript
if (toolUseBlocks.length === 0) {
```

---

### IMP-002: `parseExerciseInputs` crashes on malformed tool input

**File**: `src/claude/tool-executor.ts` lines 45-64

The function casts blindly without validation:

```typescript
const sets = (e.sets as unknown[]).map((s) => {  // crashes if sets is undefined
```

If Claude sends an exercise object without a `sets` field (or `sets` as a non-array), this throws `TypeError: Cannot read properties of undefined (reading 'map')`. The outer `catch` in `execute()` catches it, but the error message is opaque: `"Something went wrong running hevy_push_routine: Cannot read properties of undefined (reading 'map')"`.

**Fix**: Validate before casting:

```typescript
function parseExerciseInputs(exercises: unknown[]): RoutineExercisePayload[] {
  return exercises.map((ex, i) => {
    const e = ex as Record<string, unknown>;
    if (!e.name || typeof e.name !== 'string') {
      throw new Error(`Exercise ${i + 1} is missing a name.`);
    }
    if (!Array.isArray(e.sets) || e.sets.length === 0) {
      throw new Error(`Exercise "${e.name}" has no sets.`);
    }
    const sets = e.sets.map((s) => {
      const set = s as Record<string, unknown>;
      return {
        type: (set.type as 'normal' | 'warmup') ?? 'normal',
        weightLbs: typeof set.weight_lbs === 'number' ? set.weight_lbs : 0,
        reps: typeof set.reps === 'number' ? set.reps : 0,
      };
    });
    return {
      name: e.name,
      supersetId: typeof e.superset_id === 'number' ? e.superset_id : undefined,
      sets,
    };
  });
}
```

This produces actionable error messages that Claude can relay to the user.

---

### IMP-003: Tool schemas missing `required` on set properties

**File**: `src/claude/tools.ts` lines 69-85

The `sets` items in `hevy_push_routine` and `hevy_edit_routine_exercise` don't declare `required` fields:

```typescript
sets: {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['normal', 'warmup'] },
      weight_lbs: { type: 'number', description: 'Weight in pounds' },
      reps: { type: 'number' },
    },
    // no `required` array
  },
},
```

Without `required`, Claude may omit `weight_lbs` or `reps`. The code defaults these to 0, which would create sets with 0-lb weights or 0 reps -- technically valid but almost certainly wrong.

**Fix**: Add `required: ['weight_lbs', 'reps']` to the set items schema. Omitting `type` is fine since it defaults to `'normal'`.

---

### IMP-004: No timeout on Hevy API requests

**File**: `src/hevy/client.ts` lines 177-255 (`fetchJson`)

The fetch wrapper has retry logic but no request timeout. If the Hevy API hangs (DNS resolution stalls, server accepts connection but never responds), the request blocks indefinitely. During the tool loop, this means Claude's response to the user hangs with no feedback.

**Fix**: Add an `AbortController` with a timeout:

```typescript
private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${HEVY_API_BASE_URL}${path}`;
  // ...
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });
      // ...
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
```

---

### IMP-005: Empty API key sends requests instead of failing fast

**File**: `src/hevy/client.ts` line 170

```typescript
this.apiKey = apiKey ?? process.env.HEVY_API_KEY ?? "";
```

If neither parameter nor env var is set, the client silently uses an empty string and sends API requests with an empty `api-key` header. These will fail with a 401 or 403, but the error message is `"Hevy API 401 on /workouts: ..."` rather than a clear "API key not configured."

**Fix**: Throw early or surface a clear message:

```typescript
constructor(apiKey?: string) {
  this.apiKey = apiKey ?? process.env.HEVY_API_KEY ?? "";
  if (!this.apiKey) {
    console.warn("[hevy] No API key configured. Set HEVY_API_KEY in .env.");
  }
}
```

Or, for methods that aren't `verifyApiKey()`, check and return a clear error before making the request.

---

### IMP-006: Anthropic client created on every `chat()` call

**File**: `src/claude/client.ts` line 37

```typescript
const anthropic = new Anthropic();
```

A new SDK client is constructed on every user message. The constructor reads environment variables, sets up HTTP configuration, and allocates internal state. For a Telegram bot handling multiple messages per session, this is wasteful.

**Fix**: Create the client once at module scope or as a singleton:

```typescript
const anthropic = new Anthropic();

export async function chat(userMessage: string): Promise<string> {
  // ... use the shared client
}
```

Similarly, `HevyClient` and `ToolExecutor` are re-created per call (lines 38-39). Lift these to module scope as well, or pass them in.

---

## Suggestions

### SUG-001: Sanitize chat history before sending to Claude

Even after fixing CRIT-001, adding a defensive history sanitizer protects against edge cases (manual DB edits, migration bugs, etc.):

```typescript
function sanitizeHistory(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (result.length > 0 && result[result.length - 1].role === msg.role) {
      // Merge consecutive same-role messages
      result[result.length - 1] = {
        ...result[result.length - 1],
        content: result[result.length - 1].content + '\n' + msg.content,
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}
```

---

### SUG-002: DB path uses `import.meta.url` relative resolution

**File**: `src/state/db.ts` lines 5-6

```typescript
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/hevy-coach.db');
```

This works when running via `tsx` (source files), but if the project is ever compiled to `dist/`, the path resolves two levels up from `dist/state/`, which is the parent of the project root.

**Fix**: Use `process.cwd()` or a `PROJECT_ROOT` constant instead:

```typescript
const DB_PATH = path.resolve(process.cwd(), 'data/hevy-coach.db');
```

Same pattern is used in `src/claude/context.ts` (lines 9-10) for the config directory.

---

### SUG-003: Missing `dotenv/config` import in entry point

**File**: `src/index.ts`

`scripts/setup.ts` and `scripts/chat.ts` both import `'dotenv/config'` to load the `.env` file. When `src/index.ts` becomes the Telegram bot entry point in Sprint 3, it will need the same import or the environment variables won't be loaded.

---

### SUG-004: Exercise map reloaded from SQLite on every tool call

**File**: `src/claude/tool-executor.ts` lines 16-27

`loadExerciseMap()` reads the entire `exercise_map` table on every `pushRoutine()` and `editRoutineExercise()` call. For a single-user bot this is negligible, but it could be cached in the `ToolExecutor` instance:

```typescript
export class ToolExecutor {
  private exerciseMapCache: Map<string, string> | null = null;

  private getExerciseMap(): Map<string, string> {
    if (!this.exerciseMapCache) {
      this.exerciseMapCache = loadExerciseMap();
    }
    return new Map(this.exerciseMapCache); // return a copy
  }
}
```

---

## Spec Alignment

### SPEC-001: Message storage order deviates from spec

The spec prescribes storing both user and assistant messages after the Claude response (step 9 of "Context Loading Per Request"). The code stores the user message before calling Claude (line 30 of `client.ts`). This is the root cause of CRIT-001.

### SPEC-002: `hevy_get_exercise_history` uses full workout scan

The spec says the tool "resolves the exercise name to a template ID via `exercise_map`, calls the Hevy API, summarizes the response." The implementation does resolve the template ID correctly, but then calls `getExerciseHistory(templateId)` which fetches general workout pages and filters client-side for the matching exercise -- rather than using an exercise-specific API endpoint. This works but is O(all workouts) rather than O(exercise sessions). If Hevy v1 API doesn't have an exercise-specific history endpoint, this is the best available approach.

---

## What's Working Well

- **Weight conversion** is mathematically correct and well-tested against the spec's requirements. 135 lbs round-trips perfectly.
- **Defensive response normalization** in the Hevy client (camelCase/snake_case dual reading) is thorough and will survive API changes.
- **Error handling pattern** (returning `HevyApiError` objects instead of throwing, letting the tool executor surface errors conversationally) is a good design for an LLM-driven system.
- **Tool definitions** match the spec exactly and have clear descriptions.
- **System prompt assembly** matches the spec structure closely.
- **Exercise resolution cascade** (pinned map -> fuzzy search -> progressively looser queries) is well-designed.
- **Summarization** is compact and context-efficient, matching the spec's target of ~200 tokens per 5 workouts.
- **Security posture** is clean: `.env` is gitignored, no hardcoded secrets, API keys from env vars only.

---

## Next Steps

1. Fix CRIT-001 (message storage order) -- this will cause a permanent failure the first time Claude's API is slow or the process restarts under load
2. Fix CRIT-002 (exercise search pagination) -- this will cause resolution failures for exercises not in the first 30 templates
3. Address IMP-001 through IMP-004 before wiring up the Telegram transport in Sprint 3
4. Add the `dotenv/config` import to `src/index.ts` when building the Telegram entry point
