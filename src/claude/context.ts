import fs from 'node:fs';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';

import { getConfig, getTrainingMaxes } from '../state/config.js';
import { getActiveNotes } from '../state/notes.js';
import { getRecentMessages, isFirstConversation } from '../state/chatlog.js';
import { TIMEZONE, formatStoredDate, formatStoredTime } from '../util/timezone.js';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

// Every config file is mandatory — rules.md in particular carries the safety
// guardrails. A missing or unreadable file must fail closed rather than send
// Claude a prompt without them, so read errors propagate to the caller.
function readConfigFile(filename: string): string {
  return fs.readFileSync(path.join(CONFIG_DIR, filename), 'utf-8');
}

const formatNoteDate = formatStoredDate;

/**
 * Builds the system prompt as two blocks: a cacheable prefix of the four
 * config files, then the per-request state. Render order is tools → system →
 * messages, so the breakpoint on the first block also caches the tool
 * definitions — roughly 4,400 tokens that are otherwise re-billed on every
 * call, twice per user message.
 *
 * Hot-reload (AGENTS.md §7.2) is unaffected: the files are still read from
 * disk on every message, and the cache is content-addressed, so an edit
 * changes the key and simply re-warms on the next call.
 */
export function assembleSystemPrompt(freshContext?: string): Anthropic.TextBlockParam[] {
  // Config files
  const coachMd = readConfigFile('coach.md');
  const equipmentMd = readConfigFile('equipment.md');
  const programMd = readConfigFile('program.md');
  const rulesMd = readConfigFile('rules.md');

  // Current state from SQLite
  const trainingMaxes = getTrainingMaxes();
  const goals = getConfig('goals');
  const activeNotes = getActiveNotes();

  // Current local time
  const localTime = new Date().toLocaleString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  // First conversation detection
  const firstConvo = isFirstConversation();

  const trainingMaxesStr = [
    `Squat: ${trainingMaxes.squat} lbs`,
    `Bench: ${trainingMaxes.bench} lbs`,
    `Deadlift: ${trainingMaxes.deadlift} lbs`,
    `OHP: ${trainingMaxes.ohp} lbs`,
  ].join('\n');

  const instructions = [
    `## Instructions`,
    `You are Dan's workout coach, texting with him over Telegram.`,
    `Keep messages conversational and short — he's reading on a phone.`,
    `When he approves a workout, update the standing routine in Hevy`,
    `with a fun new title. Use exercise names, not template IDs —`,
    `the server resolves them.`,
    `Use the checked recent workouts supplied below. Call hevy_get_recent_workouts only when that context is missing or needs a refresh.`,
    `Results come back summarized with weights already in lbs.`,
    `Past messages are prefixed with when Dan sent them, e.g. "[Fri 10:33 PM]".`,
    `They can be up to two days old — trust Current Time below over anything`,
    `an older message said about the time of day. Never write those prefixes`,
    `yourself.`,

  ].join('\n\n');

  // Static half: read from disk, identical between requests until the user
  // edits a config file. Invariant instructions share the same cache boundary.
  const cacheablePrefix =
    [coachMd, equipmentMd, programMd, rulesMd, instructions].join('\n\n') + '\n\n';

  // Volatile half: SQLite state and the clock. Never marked for caching — the
  // time changes every minute, so a breakpoint here would pay a write per
  // minute for no reads.
  const volatileSuffix = [
    freshContext ?? '',
    // Current state
    `## Current Training Maxes\n${trainingMaxesStr}`,
    `## Current Goals\n${goals ?? ''}`,
    `## Current Time\n${localTime}`,

    // Active notes (if any)
    activeNotes.length > 0
      ? `## Active Notes\n${activeNotes
          .map(
            (n) => `- [#${n.id}, ${formatNoteDate(n.created_at)}] ${n.content}`
          )
          .join('\n')}`
      : '',

    // First conversation detection
    firstConvo
      ? `This is your first conversation. Introduce yourself briefly and ask if Dan wants to jump into a workout or talk about his setup first.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  // Zero-length text blocks are rejected by the API; volatileSuffix always has
  // Current Time today, but the filter keeps a future edit from causing a 400.
  return [
    {
      type: 'text' as const,
      text: cacheablePrefix,
      cache_control: { type: 'ephemeral' as const },
    },
    { type: 'text' as const, text: volatileSuffix },
  ].filter((block) => block.text.length > 0);
}

export function loadChatHistory(): Array<{
  role: 'user' | 'assistant';
  content: string;
}> {
  const messages = getRecentMessages({ limit: 30, maxAgeHours: 48 });
  // History spans up to 48 hours, so past turns are stamped with when they
  // were sent. Without this Claude reads a flat sequence and treats stale
  // remarks ("it's night right now") as still true on the next morning.
  return messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content:
      m.role === 'user'
        ? `[${formatStoredTime(m.created_at)}] ${m.content}`
        : m.content,
  }));
}
