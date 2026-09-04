# Final Code Review: All 4 Sprints

**Date**: 2026-09-03
**Scope**: All source code in `src/`, `scripts/`, `config/`, `ecosystem.config.cjs`
**Prior review**: `docs/review-sprint-1-2.md` (all findings addressed)

---

## Summary

- **Critical**: 0
- **Important**: 3
- **Suggestion**: 3
- **Prior fixes verified**: All 8 findings from Sprint 1+2 review confirmed fixed
- **Spec alignment**: Pass
- **Production readiness**: Good, with caveats noted below

---

## Prior Fix Verification

All findings from `docs/review-sprint-1-2.md` have been correctly addressed:

| ID | Finding | Status | Verification |
|----|---------|--------|--------------|
| CRIT-001 | Message storage order | **Fixed** | `src/claude/client.ts:107-108` -- both messages stored after Claude responds successfully. User message is appended to the in-flight array (line 77) but not persisted until success. |
| CRIT-002 | Exercise search pagination | **Fixed** | `src/hevy/client.ts:541` -- `while (true)` loop paginates through all pages, checking `pageCount` before breaking. |
| IMP-001 | Tool loop stop condition | **Fixed** | `src/claude/client.ts:99` -- now checks `response.stop_reason !== 'tool_use'` exclusively. |
| IMP-002 | parseExerciseInputs validation | **Fixed** | `src/claude/tool-executor.ts:50-53` -- validates `name` is a string and `sets` is a non-empty array before processing. |
| IMP-003 | Missing `required` on set schemas | **Fixed** | `src/claude/tools.ts:85` -- `required: ['weight_lbs', 'reps']` added to set items. |
| IMP-004 | No timeout on Hevy requests | **Fixed** | `src/hevy/client.ts:195-196` -- `AbortController` with 15-second timeout on every fetch. |
| IMP-005 | Empty API key sends requests | **Fixed** | `src/hevy/client.ts:172-173` -- logs a warning when no API key is configured. |
| IMP-006 | Client re-created per call | **Fixed** | `src/claude/client.ts:44-46` -- `Anthropic`, `HevyClient`, and `ToolExecutor` are module-level singletons. |
| SUG-001 | History sanitizer | **Fixed** | `src/claude/client.ts:24-38` -- `sanitizeHistory()` merges consecutive same-role messages. |
| SUG-002 | DB path resolution | **Fixed** | `src/state/db.ts:4` -- uses `process.cwd()` instead of `import.meta.url`. |
| SUG-003 | Missing dotenv import | **Fixed** | `src/index.ts:1` -- `import 'dotenv/config'` present. |

### CRIT-001 deep verification

Traced the full flow to confirm no path stores the user message before Claude responds:

1. `chat()` loads history from DB (line 65)
2. User message appended to in-memory array only (line 77)
3. Tool loop runs (lines 82-142)
4. On success: both messages stored (lines 107-108)
5. On max iterations: only fallback stored (line 149) -- see IMP-NEW-001 below

The sanitizeHistory belt-and-suspenders defense (line 71) catches any residual DB corruption.

---

## Important

### IMP-NEW-001: Max-iterations fallback stores assistant message without user message

**File**: `src/claude/client.ts` lines 147-150

```typescript
const fallbackText =
  '[Max tool iterations reached. Please try again or rephrase your request.]';
addMessage('assistant', fallbackText);
return fallbackText;
```

When the tool loop exhausts `MAX_TOOL_ITERATIONS` (10), the fallback assistant message is persisted but the user's message is not. This creates a gap in the chat history -- the user's message that triggered the loop is lost. More importantly, it can create consecutive assistant messages in the DB if the prior turn also ended with an assistant message (the normal case).

The `sanitizeHistory()` function prevents this from crashing the bot (it merges consecutive same-role messages), so this is not a regression of CRIT-001. But the user's message is silently dropped from history, which means Claude loses context about what the user asked.

**Fix**: Store both messages in the fallback path, same as the success path:

```typescript
addMessage('user', userMessage);
addMessage('assistant', fallbackText);
return fallbackText;
```

---

### IMP-NEW-002: HTML sanitizer does not escape bare `<`, `>`, and `&` characters

**File**: `src/telegram/client.ts` lines 23-31

The sanitizer strips unsupported HTML tags but does not escape bare special characters. Telegram's HTML parse mode requires `<`, `>`, and `&` outside of tags to be entity-encoded (`&lt;`, `&gt;`, `&amp;`). If Claude's response contains text like:

- `"your bench is < 200 lbs"`
- `"RPE 8 & above"`
- `"if reps > 5, add weight"`

Telegram will reject the message with a parse error. The catch block in `index.ts` surfaces a generic "Something went wrong" to the user, losing Claude's entire response.

This is likely to occur in practice -- a strength coach discussing numbers and thresholds will naturally produce `<` and `>` comparisons.

**Fix**: After stripping unsupported tags, escape the remaining bare special characters:

```typescript
export function sanitizeHtml(text: string): string {
  // Step 1: Strip unsupported tags
  let result = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag: string) => {
    const lower = tag.toLowerCase();
    if (ALLOWED_TAGS.has(lower)) {
      return match;
    }
    return '';
  });

  // Step 2: Temporarily replace allowed tags with placeholders
  const placeholders: string[] = [];
  result = result.replace(/<\/?(?:b|i|u|s|code|pre|a)\b[^>]*>/gi, (match) => {
    placeholders.push(match);
    return `\x00${placeholders.length - 1}\x00`;
  });

  // Step 3: Escape bare special characters
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Step 4: Restore allowed tags
  result = result.replace(/\x00(\d+)\x00/g, (_, idx) => placeholders[Number(idx)]);

  return result;
}
```

A simpler alternative: since Claude rarely uses HTML formatting in short text messages, consider switching to plain text mode (`parse_mode` omitted) and only using HTML when the response actually contains formatting tags. This avoids the escaping problem entirely for the common case.

---

### IMP-NEW-003: Message splitting can break HTML tags across chunks

**File**: `src/telegram/client.ts` lines 46-112

`splitIntoChunks` splits on `\n\n` and `\n` boundaries without awareness of HTML tag nesting. If Claude produces a response with formatting that spans paragraphs:

```
<b>Week summary</b>:

Monday: Squat day, hit 205x5
Tuesday: Rest
```

The `<b>` tag and its closing are in the first paragraph, so this example is fine. But a response like:

```
<pre>Workout plan:

Squat: 3x5 @ 185
Bench: 3x5 @ 135</pre>
```

Would be split into `<pre>Workout plan:` and `Squat: 3x5 @ 185\nBench: 3x5 @ 135</pre>`, both of which are malformed HTML and will cause Telegram parse errors.

**Fix**: The simplest fix is to catch HTML parse errors on send and retry without `parse_mode`:

```typescript
for (let i = 0; i < chunks.length; i++) {
  try {
    await ctx.reply(chunks[i], { parse_mode: 'HTML' });
  } catch {
    // HTML parse failed -- send as plain text
    await ctx.reply(chunks[i]);
  }

  if (i < chunks.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
  }
}
```

This is more robust than trying to track tag nesting across split boundaries.

---

## Suggestions

### SUG-NEW-001: SQLite connection is never closed on shutdown

**File**: `src/state/db.ts`

The `better-sqlite3` connection is opened lazily but never closed. On SIGINT/SIGTERM, `bot.stop()` is called but the DB remains open. WAL mode makes this safe against data loss (writes are flushed synchronously), but it leaves a `-wal` and `-shm` file on disk after shutdown.

**Fix**: Add a close handler:

```typescript
// In src/index.ts, alongside the existing shutdown handlers:
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  getDb().close();
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  getDb().close();
});
```

Or export a `closeDb()` function from `db.ts` that nulls the reference after closing.

---

### SUG-NEW-002: Exercise map is reloaded from SQLite on every tool call

**File**: `src/claude/tool-executor.ts` lines 16-27

`loadExerciseMap()` queries the full `exercise_map` table on every `pushRoutine()`, `editRoutineExercise()`, and `getExerciseHistory()` call. For a single-user bot this is negligible, but it could be cached in the `ToolExecutor` instance since the map rarely changes after setup.

This was noted as SUG-004 in the prior review and remains unfixed. Low priority -- keeping the note for completeness.

---

### SUG-NEW-003: `ecosystem.config.cjs` uses `tsx` in production

**File**: `ecosystem.config.cjs` line 4

```javascript
script: 'node_modules/.bin/tsx',
args: 'src/index.ts',
```

Running TypeScript via `tsx` in production adds startup overhead and memory usage from the transpilation layer. For a single-user bot this is fine, but if stability or memory usage ever becomes a concern, pre-compiling to JavaScript would reduce the footprint.

---

## End-to-End Flow Trace

Traced the "morning" workflow through the full codebase:

1. **User sends "morning"** -- Telegram delivers the update to `bot.on('text')` in `src/index.ts:57`
2. **Auth check** -- `ctx.chat.id.toString() !== AUTHORIZED_CHAT_ID` (line 59). String comparison is correct; `chat.id` is a number, converted to string.
3. **Typing indicator** -- Sent immediately (line 64), refreshed every 4s (line 67). The `try/catch` inside the interval (line 70) prevents typing indicator failures from propagating.
4. **Claude call** -- `chat(ctx.message.text)` invokes the full Claude lifecycle:
   - System prompt assembled from config files + DB state (context.ts)
   - Chat history loaded from SQLite, limited to 30 messages / 48 hours
   - History sanitized (consecutive same-role merge)
   - User message appended to in-memory array
   - Claude called with tools
5. **Tool loop** -- If Claude calls `hevy_get_recent_workouts`, `hevy_push_routine`, etc., the executor dispatches, executes, and feeds results back. Loop capped at 10 iterations.
6. **Response** -- Text extracted, both messages stored in DB
7. **HTML sanitization** -- Unsupported tags stripped (see IMP-NEW-002 for the escaping gap)
8. **Message splitting** -- Response split into <= 800-char chunks at paragraph/line boundaries
9. **Send** -- Each chunk sent with HTML parse mode, 400ms delay between chunks
10. **Cleanup** -- `clearInterval(typingInterval)` called in both success and error paths (lines 77, 82)

**No gaps found in the happy path.** The typing interval is correctly cleared in both the try and catch blocks. The auth check covers all text messages. Error handling sends a user-friendly fallback.

---

## Architecture Notes

- **Single-process, single-user design** is appropriate for the use case. No concurrency issues since Telegraf serializes updates and all SQLite access is synchronous via better-sqlite3.
- **pm2 config** is well-tuned: auto-restart with backoff, memory cap at 256MB, WAL-mode SQLite tolerates unclean restarts.
- **Error boundaries** are layered correctly: tool executor catches tool errors, chat() catches Claude/loop errors, the Telegram handler catches everything else, and the process-level handlers catch truly unhandled exceptions.
- **The `uncaughtException` handler calls `process.exit(1)`** (index.ts:17), which is correct -- pm2 will restart the process. The `unhandledRejection` handler only logs, which is also correct since unhandled rejections may be recoverable.

---

## What's Working Well

Everything noted in the Sprint 1+2 review remains solid, plus:

- **CRIT-001 fix is thorough** -- the store-after-success pattern plus the sanitizeHistory belt-and-suspenders defense makes the chat history resilient.
- **Telegram integration** is clean and handles edge cases (typing indicator refresh, error fallback, auth gating).
- **Retry logic** with exponential backoff, rate-limit honoring, and request timeouts is production-grade.
- **Module-level singletons** eliminate per-request allocation overhead.
- **pm2 configuration** is appropriate for a long-running single-user bot.

---

## Prioritized Fix List

1. **IMP-NEW-002** (HTML escaping) -- most likely to cause user-visible failures in production
2. **IMP-NEW-003** (split breaking HTML) -- same category, compounds with IMP-NEW-002
3. **IMP-NEW-001** (max-iterations user message) -- edge case but a data integrity issue
