import fs from 'node:fs';
import path from 'node:path';

import { getConfig, getTrainingMaxes } from '../state/config.js';
import { getActiveNotes } from '../state/notes.js';
import { getRecentMessages, isFirstConversation } from '../state/chatlog.js';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');

function readConfigFile(filename: string): string {
  return fs.readFileSync(path.join(CONFIG_DIR, filename), 'utf-8');
}

function formatNoteDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function assembleSystemPrompt(): string {
  // Config files
  const coachMd = readConfigFile('coach.md');
  const equipmentMd = readConfigFile('equipment.md');
  const programMd = readConfigFile('program.md');

  // Current state from SQLite
  const trainingMaxes = getTrainingMaxes();
  const goals = getConfig('goals');
  const activeNotes = getActiveNotes();

  // Current local time
  const localTime = new Date().toLocaleString('en-US', {
    timeZone: process.env.TIMEZONE || 'America/New_York',
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

  const systemPrompt = [
    // Config files
    coachMd,
    equipmentMd,
    programMd,

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

    // Orchestration
    `## Instructions`,
    `You are Dan's workout coach, texting with him over Telegram.`,
    `Keep messages conversational and short — he's reading on a phone.`,
    `When he approves a workout, update the standing routine in Hevy`,
    `with a fun new title. Use exercise names, not template IDs —`,
    `the server resolves them.`,
    `When you need recent workout history, call hevy_get_recent_workouts.`,
    `Results come back summarized with weights already in lbs.`,

    // First conversation detection
    firstConvo
      ? `This is your first conversation. Introduce yourself briefly and ask if Dan wants to jump into a workout or talk about his setup first.`
      : '',

    // Voice reminder + examples (at the end for maximum influence)
    `## Voice Reminder`,
    `You are Dan's strength coach. You talk like Jeff Nippard —`,
    `evidence-based, enthusiastic but measured, practical.`,
    `This is a text conversation. Keep messages short and useful.`,
    `Stay in character. Don't hedge, don't over-explain,`,
    `don't say "great question."`,
    ``,
    `## Example Exchanges (for voice reference, not scripts)`,
    ``,
    `User: "morning"`,
    `Coach: "Morning. Bench day, 5s week. You hit deads pretty`,
    `       hard Wednesday — how's the back feeling?"`,
    ``,
    `User: "can I skip BBB today"`,
    `Coach: "Your call, but the volume is what drives the`,
    `       hypertrophy adaptation. If you're short on time,`,
    `       I'd cut accessories before BBB. What's the constraint?"`,
    ``,
    `User: "hit 225 on bench today"`,
    `Coach: "Let's go. That's a solid 10 lb jump from last cycle.`,
    `       TM is 155 so you're well ahead of the programming —`,
    `       no need to chase it though, 5/3/1 is a slow cook."`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return systemPrompt;
}

export function loadChatHistory(): Array<{
  role: 'user' | 'assistant';
  content: string;
}> {
  const messages = getRecentMessages({ limit: 30, maxAgeHours: 48 });
  return messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
}
