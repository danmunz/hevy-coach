# Proposed implementation: exercise identity and equipment compatibility

Status: recommendation from the 2026-09-08 study. This document specifies a subsequent production change; the study prototype does not implement this release.

## 1. Data contracts

Keep the existing direct HTTP client. Add a persistent complete catalog keyed by opaque template ID. Preserve official title, raw equipment, exercise type, primary/secondary muscles, custom status, and last-seen catalog revision. Store revision metadata separately: account-local namespace, fetched time, content hash, and completeness. Use an atomic SQLite transaction to replace a complete scan; never commit partial pages. Do not persist credentials in the catalog.

Add a versioned, user-editable `config/exercises.json` containing aliases and reviewed compatibility rules. Each rule addresses a template ID and records status, required capabilities, an explanation, and the equipment-file hash it was reviewed against. Alias records contain a natural name and target ID; aliases alone do not assert compatibility. Multiple possible IDs produce candidates rather than automatic selection. No generic equipment removal or arbitrary word sorting is allowed.

Keep `equipment.md` as the authoritative inventory. Derived capability data records known present, known absent, and unknown requirements separately. The initial capability set is reviewed manually from the inventory, not inferred by an unattended model call. A missing item in prose remains unknown unless the inventory explicitly excludes it. Do not infer a rope from the presence of a pulley or dips from the presence of a bench.

The initial reviewed registry must cover all current program staples, all 20 existing aliases, and their requirements. Do not copy the prototype's 21 compatible entries as the final registry. Unconfirmed requirements remain visible and block programming that requires them; history access remains available. The rope-pushdown entry starts unresolved until the attachment is confirmed.

Use these internal types:

```ts
type ExerciseSelection = {
  templateId: string;
  officialTitle: string;
  catalogRevision: string;
};

type CompatibilityDecision = {
  status: 'compatible' | 'incompatible' | 'unresolved';
  requiredCapabilities: string[];
  unresolvedRequirements: string[];
  reason: string;
  equipmentRevision: string;
};

type DraftExercise = {
  occurrenceId: string;
  selection: ExerciseSelection;
  supersetId?: number;
  sets: Array<{ type: 'normal' | 'warmup'; weightLbs: number; reps: number }>;
};
```

Occurrence IDs distinguish repeated exercises within one routine. Keep weights in pounds until the HTTP boundary. In the initial release, routine creation supports `weight_reps` and `reps_only` templates only; reps-only sets require zero external load. Keep other metric types readable but reject writes with a specific unsupported-metric message. Weighted/assisted bodyweight and timed/distance prescriptions require a subsequent adapter change, not silent conversion to ordinary reps.

## 2. Selection, proposal, approval, and write flow

Add a read-only `hevy_find_exercises` tool accepting a query and optional template ID. Return up to 20 candidates, each with ID, official title, equipment/type metadata, compatibility decision, and whether the current routine adapter supports it. Rank exact ID, explicit alias, exact normalized title, then token-overlap candidates. Candidate ranking never authorizes a write. For ID lookups, return the requested identity even if currently incompatible so history remains usable. Indicate truncation and allow a more specific query; absence from the first result set is not a missing-template conclusion.

Change history lookup to accept `exercise_template_id`; preserve `exercise_name` as a legacy input. If both are provided, validate their consistency or return ambiguity. Name-only history queries use catalog resolution without current-equipment filtering. Never combine related but distinct template histories without an explicit analysis request that labels them separately.

Add `prepare_routine` with title and exercises specified by template ID and sets. It validates catalog membership, compatibility, and metric support, then stores an immutable draft revision with occurrence IDs. It returns a draft ID and the exact user-facing proposal text. Titles come from the catalog; they are not accepted as identity overrides.

When a preparation succeeds, the orchestration layer uses the returned proposal as the approval-bearing workout block. Additional conversational commentary must not replace or alter that block. This prevents an ID-bound draft from differing from what the user sees. New draft revisions replace previous pending proposals; revisions are never edited in place.

Change the routine-write tool to accept only `draft_id` and the existing external-change confirmation flag. Retain the current conversational approval mechanism, but require that the draft has been presented before it can be pushed. A model call cannot modify exercise IDs or sets as part of the push. This establishes payload continuity; it does not claim to make natural-language approval interpretation deterministic.

Before writing, revalidate selected IDs and compatibility against the current complete catalog and equipment revision. A title-only rename updates display metadata without changing identity. A removed ID, changed exercise metric type, or unresolved requirement blocks the write with a reason. Never substitute a new template because its title resembles a missing ID.

Run the existing remote overwrite check independently of exercise validation. Mark the fully ID-bound payload pending before the HTTP mutation. Persist the confirmed payload and its IDs atomically after success. Preserve ambiguous-write blocking and do not retry mutations automatically.

Replacement tools address `occurrenceId`, not the first matching name. A replacement creates a new draft revision containing the selected new ID and exact prescription. Explicit user requests for a specific replacement follow existing approval policy; changes inferred by Coach require presentation and approval. Equipment adaptations remain explicit selections, not aliases. For a kettlebell row without a suitable template, explain the available logging choices; custom-template creation is not added in this release.

## 3. Migration and compatibility

Add version 2 confirmed and pending routine payloads with per-occurrence template IDs. Keep version 1 readers until all local state is reconciled. Database schema changes use direct additive SQL, consistent with this single-user project.

Import the current exercise map as candidate aliases, checking every target against the fetched catalog and retaining the raw legacy values. Read official titles from the catalog, never from the existing `hevy_title` column. Flag missing IDs and conflicting aliases instead of guessing replacements. Keep custom identities account-local.

For old pending mutations, use the embedded template-ID evidence where complete. Never clear a pending record just to migrate it. Recovery must compare the intended ID-bound payload with the remote routine as before. Missing evidence leaves recovery blocked and explains which exercise needs reconciliation.

For old confirmed routines, do not infer historical identity from today's alias table. Attempt reconciliation using the current remote routine and the complete cached programming fields. If identity cannot be established without assumptions, mark the old baseline unverified and retain it. The user can explicitly confirm replacing the remote routine, using the existing override path. Do not silently adopt modified remote programming as the previously approved baseline.

Maintain old completed-workout records and historical IDs unchanged. Do not rewrite workout history or merge IDs to make migration easier.

Name-based write tools are removed from new model tool definitions at activation; legacy stored chat messages remain readable. The server returns an explicit migration error if an old name-based write call reaches the executor. Existing equipment Markdown remains valid and continues to be read on every turn. Document the new registry, tools, metric restrictions, and setup procedures in README and AGENTS.md.

## 4. Refresh and prompt behavior

Fetch the complete catalog during setup and on explicit operator refresh. Refresh in the existing process when the snapshot is older than 24 hours, with jitter and a single shared in-flight request. Validate missing selected IDs with a fresh scan before reporting them absent. Failed scans preserve the previous complete snapshot and surface a freshness failure; allow history reads from known IDs but block a routine write until required catalog validation succeeds. Do not scan independently for every alias miss.

On each incoming turn, compare the current equipment-file hash with the revision recorded by compatibility rules. If it changed, continue hot-reloading the new prose immediately and mark derived decisions stale. Require review/refresh of the derived rules before routine writes; do not continue using a removed capability while regeneration is pending. A whitespace-only edit may cause an unnecessary review in the first release; favor simple content hashing over an unreliable semantic diff.

Catalog refresh does not invalidate all compatibility rules unnecessarily: title-only changes preserve identity; equipment/type changes or disappeared IDs invalidate affected rules. New entries begin unresolved. An explicit refresh is also needed after adding or recreating a custom exercise; equipment is not the only lifecycle trigger.

Place the compact reviewed exercise list and invariant tool instructions in the cached prompt prefix. Put freshness timestamps, stale-state notices, and per-request decisions below the cache boundary. Full catalog retrieval remains a tool capability rather than inserting all 455 records into every prompt. Read editable config from disk every turn as today.

## 5. Verification, rollout, and rollback

Implement in three atomic stages, each with its own conventional commit and clean type checks:

1. Add catalog persistence, raw metadata normalization, search, and diagnostics behind `HEVY_EXERCISE_CATALOG_V2=0` by default. Run shadow resolution on the fixed fixtures and inspect the initial alias/requirements migration report. No live writes use the new path yet.
2. Add ID-bound drafts, occurrence-based replacements, legacy-state readers, and compatibility validation. Test the complete prepare/present/approve/push flow with a fake Hevy writer. Run `npm run chat` in its existing scratch/read-only mode to verify the conversational proposal and error behavior.
3. After local checks pass, back up SQLite using its backup facility, activate the flag, and restart once. Verify a user-approved routine write and read it back. A study result alone is not authorization to overwrite a live routine.

Required regression checks: all 24 study cases; exact catalog IDs and non-hex IDs; opposite cable-twist directions; military versus overhead identities; metadata with cable classified as machine; duplicate names/occurrences; absent and recreated custom IDs; failed/partial refresh recovery; equipment edits between preparation and approval; unsupported metrics; attempted payload changes at push; ID-bound pending recovery; migration without sufficient evidence; prefix-cache stability; and exact pounds-to-API conversion.

Log resolution outcomes using structured reason codes: `ambiguous_identity`, `missing_template`, `incompatible_equipment`, `unresolved_requirement`, `stale_equipment_rules`, `unsupported_metric`, and `legacy_identity_unverified`. Include candidate IDs and revisions, not credentials or complete private conversations. Continue existing HTTP and mutation telemetry.

Rollback must not restore an old production database after new live writes: that would lose confirmed state. Disable v2 writes, reconcile any pending mutation, and retain the v2 payloads. Restore the old application only with a compatibility reader or an explicitly reconciled baseline; use read-only operation while reconciliation is required.

## 6. Complete-catalog draft evidence

The bounded two-pass catalog review now exists at `scripts/exercise-study/catalog-compatibility.review.json`. It covers every entry in the frozen 455-template catalog: 300 available, 136 unavailable, and 19 review. It is input to stage 1, not a replacement for it.

Stage 1 must import it as draft evidence keyed by template ID, record its catalog revision and equipment-file hash, and preserve the source/audit metadata. It must sample the `available` decisions before treating them as reviewed rules. The 19 `review` entries remain write-blocking until their narrowly described setup or attachment fact is confirmed; they may never degrade to runtime fuzzy matching. A fresh catalog or equipment revision invalidates affected records in the same way as any other draft compatibility rule.
