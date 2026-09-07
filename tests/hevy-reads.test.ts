import assert from "node:assert/strict";
import test from "node:test";
import { HevyClient } from "../src/hevy/client.js";
import { resolveExerciseName } from "../src/hevy/exercise-pins.js";

const workout = { id: "w1", title: "Session", exercises: [
  { title: "Squat", exercise_template_id: "squat", notes: "Keep tempo", sets: [
    { type: "warmup", weight_kg: 20, reps: 5, rpe: 4 },
  ] },
] };

test("events preserve order and normalize both event shapes across all pages", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (url) => {
    paths.push(String(url));
    const page = new URL(String(url)).searchParams.get("page");
    return Response.json({ page: Number(page), page_count: 2, events: page === "1"
      ? [{ type: "deleted", id: "gone", deleted_at: "2026-01-02T00:00:00Z" }]
      : [{ type: "updated", workout }] });
  };
  try {
    const events = await new HevyClient("fixture").getWorkoutEvents("2026-01-01T00:00:00Z");
    assert.equal(paths.length, 2);
    assert.equal(events[0].type, "deleted");
    assert.equal(events[1].type, "updated");
    if (events[1].type === "updated") {
      assert.equal(events[1].workout.exercises[0].notes, "Keep tempo");
      assert.equal(events[1].workout.exercises[0].sets[0].rpe, 4);
    }
  } finally { globalThis.fetch = original; }
});

test("invalid and incomplete event scans fail instead of returning partial state", async () => {
  const original = globalThis.fetch;
  try {
    for (const payload of [
      { page: 1, page_count: 2, events: [] },
      { page: 1, page_count: 1, events: [] },
      { page: 1, events: [] },
      { page: 1, page_count: 1, events: [{ type: "future" }] },
      { page: 1, page_count: 1, events: [{ type: "updated", workout: { ...workout, exercises: [null] } }] },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      await assert.rejects(new HevyClient("fixture").getWorkoutEvents("2026-01-01"));
    }
  } finally { globalThis.fetch = original; }
});

test("accepts only Hevy's undocumented empty event-page shape", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ page: 1, page_count: 1, workouts: [] });
    assert.deepEqual(await new HevyClient("fixture").getWorkoutEvents("2026-01-01"), []);

    for (const payload of [
      { page: 1, page_count: 1, workouts: [workout] },
      { page: 1, page_count: 2, workouts: [] },
      { page: 2, page_count: 1, workouts: [] },
      { page: 1, page_count: 1, events: [], workouts: [] },
      { page: 1, page_count: 1, events: null, workouts: [] },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      await assert.rejects(new HevyClient("fixture").getWorkoutEvents("2026-01-01"));
    }
  } finally { globalThis.fetch = original; }
});

test("template misses share one refresh and repeated misses do not repeat refresh", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ page: 1, page_count: 1, exercise_templates: calls === 1
      ? [{ id: "bar", title: "Squat (Barbell)" }]
      : [{ id: "bar", title: "Squat (Barbell)" }, { id: "custom", title: "Custom Squat" }] });
  };
  try {
    const client = new HevyClient("fixture");
    await client.fetchAllTemplates();
    const results = await Promise.all([client.searchExerciseTemplates("Custom"), client.searchExerciseTemplates("Custom")]);
    assert.equal(calls, 2);
    assert.equal(results[0][0].id, "custom");
    await client.searchExerciseTemplates("Missing");
    await client.searchExerciseTemplates("Missing");
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test("resolution accepts punctuation and rejects equipment substitutions or duplicate titles", async () => {
  const known = new Map([["Pull Up", "pull"]]);
  assert.equal(await resolveExerciseName("Pull-Up", known, async () => []), "pull");
  const candidates = [{ id: "dumbbell", title: "Bench Press (Dumbbell)" }];
  assert.equal(await resolveExerciseName("Bench Press (Barbell)", new Map(), async () => candidates), null);
  assert.equal(await resolveExerciseName("Bench Press", new Map(), async () => candidates), null);
  assert.equal(await resolveExerciseName("Custom Squat", new Map(), async () => [
    { id: "a", title: "Custom Squat" }, { id: "b", title: "Custom Squat" },
  ]), null);
});

test("failed template refresh can recover on the next search", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) return new Response("Invalid", { status: 400 });
    return Response.json({ page: 1, page_count: calls > 2 ? 1 : 0, exercise_templates: calls > 2
      ? [{ id: "custom", title: "Custom" }] : [] });
  };
  try {
    const client = new HevyClient("fixture");
    await client.fetchAllTemplates();
    await assert.rejects(client.searchExerciseTemplates("Custom"));
    assert.equal((await client.searchExerciseTemplates("Custom"))[0].id, "custom");
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test("ambiguous pinned punctuation aliases fail closed", async () => {
  assert.equal(await resolveExerciseName("Pull-Up", new Map([
    ["Pull Up", "one"], ["Pull-Up", "two"],
  ]), async () => []), null);
});

test("HTTP telemetry identifies successful requests without query contents", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ workouts: [workout] });
  try {
    const events: import("../src/hevy/client.js").HevyHttpEvent[] = [];
    const client = new HevyClient("fixture", undefined, (event) => events.push(event));
    assert.equal((await client.getRecentWorkoutRecords())[0].id, "w1");
    assert.equal(events.length, 1);
    assert.equal(events[0].path, "/workouts");
    assert.equal(events[0].success, true);
    assert.equal(events[0].status, 200);
  } finally { globalThis.fetch = original; }
});

test("a malformed template refresh retains the complete old cache", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ page: 1, page_count: 1,
      exercise_templates: [{ id: "old", title: "Existing" }] });
    if (calls === 2) return Response.json({ page: 1, page_count: 2,
      exercise_templates: [{ id: "new", title: "New" }] });
    return Response.json({ page: 2, page_count: 2, exercise_templates: [] });
  };
  try {
    const client = new HevyClient("fixture");
    await client.fetchAllTemplates();
    await assert.rejects(client.fetchAllTemplates(true));
    assert.deepEqual((await client.fetchAllTemplates()).map((entry) => entry.id), ["old"]);
  } finally { globalThis.fetch = original; }
});

test("home gym pins select cable rows and exclude dips", async () => {
  const { resolveExerciseMap, EXERCISE_PINS } = await import("../src/hevy/exercise-pins.js");
  const templates = [
    { id: "51A0EDAA", title: "Ring Dips", primaryMuscleGroup: "chest" },
    { id: "1DF4A847", title: "Seated Row (Machine)", primaryMuscleGroup: "upper_back" },
    { id: "F1D60854", title: "Seated Cable Row - Bar Grip", primaryMuscleGroup: "upper_back" },
    { id: "0393F233", title: "Seated Cable Row - V Grip (Cable)", primaryMuscleGroup: "upper_back" },
    { id: "5046D0A9", title: "Front Squat", primaryMuscleGroup: "quadriceps" },
    { id: "BE640BA0", title: "Face Pull" },
    { id: "94B7239B", title: "Triceps Rope Pushdown", primaryMuscleGroup: "triceps" },
  ];
  const map = await resolveExerciseMap(async (query) =>
    templates.filter((template) => template.title.toLowerCase().includes(query.toLowerCase())));
  assert.equal(map.has("Dips"), false);
  assert.equal(map.get("Seated Row"), "F1D60854");
  assert.equal(map.get("Seated Row (V Grip)"), "0393F233");
  assert.equal(EXERCISE_PINS["Dips"], undefined);
  assert.equal(map.get("Front Squat"), "5046D0A9");
  assert.equal(map.get("Face Pull"), "BE640BA0");
  assert.equal(map.get("Triceps Rope Pushdown"), "94B7239B");
  assert.equal(EXERCISE_PINS["Seated Row"].query, "Seated Cable Row - Bar Grip");
});
