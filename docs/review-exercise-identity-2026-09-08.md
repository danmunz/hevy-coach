# Exercise identity and equipment compatibility study

Date: 2026-09-08. Status: study complete; production redesign proposed, not deployed.

## Recommendation

Introduce an ID-based exercise-selection contract and a persistent, metadata-preserving catalog. Resolve identity before presenting a workout for approval. Store that identity with each proposed and confirmed exercise, and validate it at the API boundary. Add an explicit equipment-compatibility layer with unresolved outcomes. Keep natural names for conversation and use official titles for disambiguation.

Do not replace the current pins with a model-generated, supposedly definitive full-catalog mapping yet. A model can suggest classifications, but cannot establish missing equipment facts. A reviewed, incremental compatibility registry is a more defensible first release. It still contains personal overrides; the improvement is separating their purpose and preserving evidence, not eliminating every mapping table.

The reference implementation is intentionally small and manually configured. It is not an automatic equipment compiler or production-ready resolver. Its limitations are part of the result.

## Evidence and reproducibility

The study fetched all five pages of the account catalog on 2026-09-08 at 12:23:34 UTC: 455 templates, including four custom templates. The response array SHA-256 is `2867a87729c8897de506661770975d6faf3c4602b8f5e3ba7bbce77c1ff2c4c0`.

Artifacts are in [scripts/exercise-study](../scripts/exercise-study/README.md): raw catalog and mapping snapshots, official schema excerpt, external repository revisions, a deterministic prototype, 24 fixtures, and full results. The mapping snapshot was obtained with SQLite read-only mode. The harness uses the actual production resolver and Hevy client with a fake transport; it does not open the application database. Only catalog acquisition used the live Hevy API, and only GET requests were sent. No paid model calls ran: expenditure was $0.

Run `npx tsx scripts/exercise-study/run.ts` to reproduce the comparison offline. It emits JSON and fails if the reference violates a specified expectation. Implementation hashes distinguish future baseline changes. Runtime duration is informational and will vary.

This is an engineering regression study, not a blinded trial. Expected results were specified before running the evaluation, but the reference rules and fixtures were authored together. The comparison tests contracts and known incidents; it does not estimate generalization accuracy or full-conversation success. Baseline scores concern the resolver boundary, not whether Claude would have prevented the request in conversation.

## Current data flow and failure mechanisms

| Boundary | Current behavior | Consequence |
|---|---|---|
| Setup | Pin queries resolve to IDs; only mappings are persisted | Catalog metadata and most available exercises are absent from durable selection state |
| Prompt/tool schema | Coach is instructed to use display names; server resolves IDs | Identity remains undecided until after conversational approval |
| Runtime resolver | Cached name lookup, then exact/word-order search | Existing mappings bypass live identity validation; equipment is not checked |
| History | Name is resolved to an ID before history retrieval | Correct API identity is available, but name lookup remains a failure point |
| Routine write | Incoming names resolve independently on each invocation | Same conversational name may refer to a different template after mapping changes |
| Confirmation | Confirmed payload stores names; mappings are persisted separately | A later check reconstructs the old prescription with the current map |
| Pending mutation | Stores payload and name-to-ID evidence | Better identity evidence exists here than in the confirmed payload |
| Replacement | Selects the old exercise by its first matching name | Duplicate exercise occurrences cannot be addressed unambiguously |
| Summary | Workout summaries retain template IDs | Useful identity exists in context but write tools cannot accept it |

`confirmHevyMutation()` writes the display name into `hevy_title`, so that column is not a reliable source of official titles. Setup also stores display names there. Neither path should be used to establish canonical identity.

## Findings

| ID | Severity | Finding | Verification/status |
|---|---|---|---|
| EXI-001 | High | Name resolution occurs after approval and confirmed payloads do not embed IDs | Source inspection; reference binding and migration checks pass |
| EXI-002 | High | Equipment restrictions exist in prose but not at the resolver boundary | Machine-row and bench-dip fixtures return IDs in baseline; reference rejects |
| EXI-003 | High | Existing mappings can retain absent or misinterpreted identities | Synthetic deleted custom-ID fixture returns stale ID in baseline; reference refuses |
| EXI-004 | High | Raw catalog equipment categories cannot be used as a complete gym filter | Live cable templates classified as `machine`; custom ball exercise classified as `none` |
| EXI-005 | Medium | Broader aliases can collapse distinct catalog identities | Live catalog contains distinct shoulder/overhead/military press templates; generic token sorting collides for opposite cable-twist directions |
| EXI-006 | Medium | Fixed hex validation would reject real built-in templates | Three non-hex built-in IDs in live response; treat IDs as opaque strings |
| EXI-007 | Medium | Available exercise metrics exceed the routine tool's weight/reps schema | Live catalog has duration, distance, assisted, weighted-bodyweight, and other types; separate adapter support from equipment eligibility |
| EXI-008 | Medium | Failures are difficult to diagnose from production telemetry | Logs identify tool status and input keys but not structured resolution reasons; no claim that original failed payloads were recovered |

These findings are not production fixes. Earlier morning fixes remain separate working-tree changes.

### Catalog metadata

Every template has all seven inspected fields: `id`, `title`, `type`, `primary_muscle_group`, `secondary_muscle_groups`, `equipment`, and `is_custom`. Presence does not imply sufficient semantics.

The official GET schema uses `equipment`, which matches the live response. Some external models use an `equipmentCategory` property; that is not evidence of the actual GET field name. The current local reader discards equipment, secondary muscles, and exercise type.

Equipment distribution: 145 machine, 108 none, 75 barbell, 70 dumbbell, 16 other, 13 kettlebell, 13 resistance band, eight plate, and seven suspension. Thirty-one titles matching the study's explicit cable/rope pattern have `equipment: machine`. This count is a lower bound on pulley-compatible movements, not a complete classification.

Examples:

- `F1D60854`, Seated Cable Row - Bar Grip, is `machine`, although the equipment description explicitly supports it.
- `0393F233`, Seated Cable Row - V Grip (Cable), is also `machine`.
- Custom Crunch (Stability Ball) is `none`; the inventory does not establish a stability ball.
- Triceps Rope Pushdown is pinned locally, but the attachment inventory lists a bar, single handle, and triangle attachment. A rope is unconfirmed, not necessarily absent.
- Cable Fly Crossovers requires a geometry decision that cannot be inferred from the category or upper/lower-pulley description alone.

There are no duplicate case-insensitive trimmed titles in this snapshot; duplicate-title behavior is tested synthetically. Full-catalog token sorting produces a real collision: Cable Twist (Down to up), `92D858EA`, and Cable Twist (Up to down), `A2D838BD`. This does not prove the current substring-search pipeline selects the wrong one; it demonstrates that generic word-order equivalence is not a safe identity rule. The prototype therefore preserves word order and only relocates the explicit dumbbell prefix.

Built-in IDs `4288G454`, `9373FSD1`, and `32HKJ34K` are not hexadecimal. External descriptions of all built-in IDs as eight-character hex are overgeneralizations. A catalog-membership check is preferable to format assumptions. One snapshot cannot establish long-term ID stability; custom deletion/recreation remains a lifecycle concern.

The catalog also contains Overhead Press (Dumbbell), Shoulder Press (Dumbbell), Standing Military Press (Barbell), and Overhead Press (Barbell) as distinct IDs. Do not import broad shoulder/military/overhead synonym tables as identity assertions. Explicit personal defaults may choose one, but history must remain separated by ID.

### Local comparison

| Category | Cases | Current resolver | Reference |
|---|---:|---:|---:|
| Aliases | 6 | 3 | 6 |
| Equipment | 6 | 2 | 6 |
| Ambiguity | 4 | 3 | 4 |
| Identity | 4 | 1 | 4 |
| Total selection cases | 20 | 9 | 20 |

The reference additionally passes four lifecycle scenarios covering equipment removal, rename/recreation, failed/incomplete refresh recovery, and legacy migration. These are asserted against the prototype; they are not four additional comparative measurements of the production application. The existing production cache recovery tests were run separately and pass.

The seven unexpected baseline selections are E3, E4, E5, E6, U4, I3, and I4. They include explicitly incompatible selections and selections for which evidence is insufficient. A missing rope is not classified as definitely incompatible.

On the entire catalog, the prototype classifies 21 entries as compatible, 57 as incompatible, and 377 as unresolved. Compatible rules are manually grounded in the inventory/program; incompatible rules cover explicit exclusions and dedicated machines. Unknown entries include many movements that may be feasible. This deliberately low recall prevents the 20/20 fixture score from being misread as a complete gym catalog. It is superseded as a coverage result by the bounded full-catalog review below; it remains useful only as a no-guessing reference implementation.

### Complete catalog review

The bounded two-pass review completed against the frozen 455-template catalog. The resulting local artifact is [`catalog-compatibility.review.json`](../scripts/exercise-study/catalog-compatibility.review.json). It has one audited decision for every opaque Hevy ID: **300 available**, **136 unavailable**, and **19 review**. No template is omitted or silently treated as a fuzzy-name fallback.

The nineteen `review` records are the honest residual work queue: Cable Crunch; Cable Fly Crossovers; Cable Pull Through; Climbing; custom Crunch (Stability Ball); three decline-bench movements; custom Farmers Carry; Inverted Row; Low Cable Fly Crossovers; Meadows Row; Nordic Hamstrings Curls; Weighted Pull Up; Seated Cable Row - Bar Wide Grip; Seated Chest Flys (Cable); Single Arm Cable Crossover; Squat Row; and Standing Cable Glute Kickbacks. They require a specific confirmation about an attachment, rack geometry, decline setup, custom-template meaning, or available support—not another name-matching heuristic.

The audit changed 29 initial labels. That disagreement is evidence that the generated labels are a review aid rather than an authority. The runner therefore records both response hashes and the changed IDs, validates ID/order/count on every batch, and retains `review` rather than promoting uncertainty to availability.

The prototype accepts a known barbell selection, keeps its ID after a synthetic rename, rejects an absent/recreated ID, and captures the API exercise ID without a network write. It also shows that current alias mappings cannot prove the ID of a legacy approved selection. It does not implement a complete conversational approval protocol or test model adherence to one.

## External precedent and limitations

Repository revisions are recorded in `external-revisions.json`. The links below refer to source or issue evidence inspected during this conversation. No external code was executed or incorporated wholesale.

| Source | Supported conclusion | Limit |
|---|---|---|
| [chrisdoc search PR](https://github.com/chrisdoc/hevy-mcp/pull/281) | Full-catalog search reduces repeated manual pagination | Candidate discovery does not establish equipment compatibility |
| [chrisdoc cache issue](https://github.com/chrisdoc/hevy-mcp/issues/384) | A failed in-flight fetch can poison later searches | Historical, closed defect; not a claim about current release |
| [diecoscai examples](https://github.com/diecoscai/hevy-mcp/blob/b3a8016b6dcb69b332cee94610b538f8577cd4c1/docs/examples.md) | Resolve IDs before composing writes | Assistant still interprets the requested movement |
| [diecoscai schema fix](https://github.com/diecoscai/hevy-mcp/pull/4) | Exercise-creation schemas and real API behavior diverged | GET response types must be verified separately from create-input enums |
| [bondbenbond client](https://github.com/bondbenbond/hevy-mcp/blob/4dbf15fc8000f938f776cddca7b314b61859e24c/src/main/java/io/github/hevymcp/hevy/HevyClient.java) | Searches metadata and returns real candidates | Substring matching, not a personal equipment classifier |
| [Swift normalizer](https://github.com/gossamr/swift-workout-importer/blob/5db7790a1955cf03a73b5451a88092fbde55c43d/Sources/WorkoutImporter/Utilities/NameNormalizer.swift) | Preserve parenthetical equipment/variant tokens | Some phrase synonyms would merge distinct Hevy templates; do not copy blindly |
| [Fitbod migration matcher](https://github.com/StartupBros-com/fitbod-hevy-migration/blob/a869223b012e142a8c2959638bf0ed2d2f341483/migrate.py) | Equipment-stripping and fuzzy acceptance expose collision risks | Source-derived risk; no reproduced user import incident claimed |
| [Workout creator](https://github.com/thebruge/hevy-workout-creator/blob/9c38ed55b6ddd84b60c21970c8bd79192ba8b26c/hevy.py) | Resolution tables and post-write verification are useful | Verifying the resolved name cannot validate the original interpretation |
| [Personal ID registry](https://github.com/Easty11/hevy-client/blob/771d6c41d40ce778d3f7ca812012c0471f53fafa/HEVY_EXERCISE_IDS.md) | Account-specific custom mappings and notes are useful | ID format/stability claims are not API guarantees |

No reviewed project demonstrated a verified automatic inventory-to-full-catalog compiler. This is a scoped search finding, not proof that none exists. Pattern reuse is recommended over adopting a wrapper: the current direct-HTTP boundary is adequate, and a wrapper would not establish the missing gym facts.

## Paid evaluation result

The complete-catalog coverage gap warranted a bounded model-assisted setup review. The run made no Hevy requests or database writes. It used 20-entry batches, two passes, disabled SDK retries, fixed 32,000-byte input caps, fixed 4,096-output-token caps, and strict response validation. Earlier format/interruption attempts were included in the ceiling: **92 requests maximum / $9.656320 maximum reservation** under Sonnet 5's $2/M input and $10/M output rates. The recorded completed review used 110,381 input and 51,185 output tokens, for **$0.732612 observed cost**.

This is not a claim of ground-truth automation. The practical result is a full, ID-addressable availability inventory plus a short, actionable review queue. A later production activation must import this artifact into the versioned compatibility contract, sample the 300 `available` decisions, and resolve or keep blocking the nineteen `review` records. It must not begin writing routines from this research artifact alone.

## Implementation priority

1. Persist the complete catalog and introduce ID-based draft selection, approval, and writes. Preserve natural conversation and existing overwrite/pending-mutation safeguards.
2. Introduce reviewed equipment requirements and account-specific overrides. Separate compatible movements from the subset supported by the current weight/reps adapter. Validate unknown requirements before a write, with actionable explanations.
3. Import the complete review as draft compatibility evidence, then sample the available set and resolve the nineteen explicit review records before enabling v2 writes. Model-assisted setup remains a way to draft reviewable evidence, not an authority over missing facts.

The [implementation specification](exercise-identity-implementation.md) defines interfaces, migration, invalidation, acceptance criteria, and rollback. It is proposed implementation work; this study did not deploy it.

## Verification

- Offline study: 20 reference selection expectations and four lifecycle scenarios passed; forbidden transport requests: zero.
- Negative assertions: equipment-stripping collision reproduced; direction tokens preserved; fabricated IDs rejected.
- Existing resolver/history/routine test subset: 29 tests passed, including cache recovery and bodyweight parsing.
- `npx tsc --noEmit` and `npm run typecheck` passed.
- Full-catalog review: 455/455 opaque IDs classified and independently audited; 29 labels changed by audit; observed model cost $0.732612 with a precomputed $9.656320 ceiling.
- No production database writes, Hevy mutations, restart, or live conversational smoke test were required: production modules were not edited in this study.
