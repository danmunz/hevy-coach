import Anthropic from '@anthropic-ai/sdk';

export const TOOLS: Anthropic.Tool[] = [
  // --- Hevy: Read ---
  {
    name: 'hevy_get_recent_workouts',
    description:
      "Get the user's recent completed workouts from Hevy, summarized with weights in lbs. Use to see what they've done lately and determine program state.",
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent workouts (default 5, max 10)',
        },
      },
    },
  },
  {
    name: 'hevy_get_exercise_history',
    description:
      "Get the user's performance history for a specific exercise. Useful for checking progression over time. Use exercise display name (e.g., 'Bench Press'). It defaults to the last 90 days; pass dates only when the user needs a specific period.",
    input_schema: {
      type: 'object',
      properties: {
        exercise_name: {
          type: 'string',
          description: "Exercise display name, e.g. 'Squat', 'Bench Press'",
        },
        start_date: { type: 'string', description: 'Optional ISO 8601 start date.' },
        end_date: { type: 'string', description: 'Optional ISO 8601 end date.' },
      },
      required: ['exercise_name'],
    },
  },
  {
    name: 'hevy_get_routines',
    description:
      'List saved routines. Use to find the current standing routine.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },

  // --- Hevy: Write ---
  {
    name: 'hevy_push_routine',
    description:
      "Create or update the standing Hevy routine with today's workout. Call ONLY after the user approves. Use exercise display names — the server resolves template IDs. Give it a fun, creative title (no date).",
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Fun routine title, <40 chars, no date',
        },
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: "Exercise display name, e.g. 'Overhead Press'",
              },
              superset_id: {
                type: 'number',
                description: 'Optional superset group number',
              },
              sets: {
                type: 'array',
                description: 'One entry per distinct consecutive set. Use count for repeated identical sets; use warmup: true for warmups.',
                items: {
                  type: 'object',
                  properties: {
                    weight_lbs: {
                      type: 'number',
                      description: 'Weight in pounds',
                    },
                    reps: { type: 'number' },
                    count: { type: 'number', description: 'Identical repetitions, default 1, maximum 20.' },
                    warmup: { type: 'boolean', description: 'True only for warmup sets.' },
                    type: { type: 'string', enum: ['normal', 'warmup'], description: 'Legacy form; omit for new calls.' },
                  },
                  required: ['weight_lbs', 'reps'],
                },
              },
            },
            required: ['name', 'sets'],
          },
        },
        overwrite_external_changes: {
          type: 'boolean',
          description: 'Set true only after the user explicitly confirms replacing changes currently present in Hevy.',
        },
      },
      required: ['title', 'exercises'],
    },
  },
  {
    name: 'hevy_edit_routine_exercise',
    description:
      'Swap or modify a single exercise in the current Hevy routine without regenerating the whole workout. Use for post-approval quick edits.',
    input_schema: {
      type: 'object',
      properties: {
        replace_exercise: {
          type: 'string',
          description: 'Exercise to remove (display name)',
        },
        with_exercise: {
          type: 'string',
          description: 'Replacement exercise (display name)',
        },
        sets: {
          type: 'array',
          description:
            'New set scheme. If omitted, keeps the original sets.',
          items: {
            type: 'object',
            properties: {
              weight_lbs: { type: 'number' },
              reps: { type: 'number' },
              count: { type: 'number', description: 'Identical repetitions, default 1, maximum 20.' },
              warmup: { type: 'boolean', description: 'True only for warmup sets.' },
              type: { type: 'string', enum: ['normal', 'warmup'], description: 'Legacy form; omit for new calls.' },
            },
            required: ['weight_lbs', 'reps'],
          },
        },
        overwrite_external_changes: {
          type: 'boolean',
          description: 'Set true only after the user explicitly confirms replacing changes currently present in Hevy.',
        },
      },
      required: ['replace_exercise', 'with_exercise'],
    },
  },

  // --- Notes ---
  {
    name: 'save_note',
    description:
      "Save a persistent coaching note. Use when the user mentions an ongoing injury, schedule constraint, preference, or anything that should persist beyond the current conversation window. Don't ask permission — save it when your judgment says it matters.",
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            "E.g., 'Left shoulder pain on bench — achy at bottom of ROM'",
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'clear_note',
    description:
      'Deactivate a note that is no longer relevant (injury resolved, vacation over, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'number' },
      },
      required: ['note_id'],
    },
  },

  // --- Config ---
  {
    name: 'update_training_maxes',
    description:
      'Update one or more training maxes. Only include the lifts being changed. Never call without explicit user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        squat: { type: 'number' },
        bench: { type: 'number' },
        deadlift: { type: 'number' },
        ohp: { type: 'number' },
      },
    },
  },
];
