# Exercise identity study artifacts

This directory is an isolated research harness, not application configuration.
It does not implement the proposed production redesign.

## Reproduce the offline study

From the project root, with existing development dependencies installed:

```sh
npx tsx scripts/exercise-study/run.ts
npx tsc --noEmit
npm run typecheck
npx tsx --test tests/hevy-reads.test.ts tests/history.test.ts tests/routine-inputs.test.ts
```

The runner prints a JSON report and exits nonzero if any reference expectation fails.
It uses a fake catalog transport, no database, no credentials, and no paid model calls.
It captures current production resolver logs in its output. The checked-in result is
from the 2026-09-08 working tree including the earlier name/bodyweight fixes;
implementation hashes are included. Elapsed milliseconds can differ on reruns.

## Files

- `catalog.snapshot.json`: all 455 account-visible templates from five GET pages; includes four account-specific custom templates. Keep this local research data private when sharing the report publicly.
- `mappings.snapshot.json`: exercise aliases read from SQLite in read-only mode; no chat, keys, or routine data.
- `equipment.snapshot.md`: inventory used to derive the manual prototype profile. Offline results use these frozen assumptions, not later edits to the live inventory.
- `official-schema.snapshot.json`: GET template schema extracted as JSON from the official Swagger initialization document at https://api.hevyapp.com/docs/swagger-ui-init.js on 2026-09-08. No JavaScript from that document was executed.
- `external-revisions.json`: public repository revisions inspected during the research.
- `cases.ts`: 20 specified selection cases and four lifecycle cases, with expected identities/outcomes and evidence.
- `reference.ts`: explicit aliases, manually reviewed compatibility rules, ID binding, and isolated lifecycle prototype.
- `run.ts`: production-resolver comparison, catalog analysis, and local contract assertions.
- `results.json`: recorded output, including every catalog classification and baseline diagnostic.
- `fetch-catalog.ts`: optional read-only catalog acquisition using `HEVY_API_KEY` from `.env`; prints JSON and does not update any snapshot or DB automatically.

To inspect a fresh catalog, run `npx tsx scripts/exercise-study/fetch-catalog.ts`.
Refreshing evidence is a separate research operation: review changed entries and
expected answers before replacing a snapshot. Never treat a fresh catalog as an
automatic replacement for confirmed IDs or compatibility decisions.

## Interpretation

The reference passes 20 selection cases and four lifecycle cases. The baseline
passes nine selection cases. Lifecycle results are not a comparative production
score. The baseline is the resolver boundary, not a full Claude conversation.

This is a designed regression set, not a held-out or randomized benchmark.
The initial prototype's small reviewed registry leaves 377 of 455 templates
unresolved. It is a safety demonstration only, not the gym-aware catalog.

`npm run study:exercise-catalog` performs the separately authorized, bounded
two-pass review and writes `catalog-compatibility.review.json`. It assigns every
catalog ID `available`, `unavailable`, or `review`; a review decision is an
explicit work item, never an implicit fallback. The fixed schedule (twenty
review requests plus earlier diagnostic/interrupted calls), disabled SDK
retries, 32,000-byte request ceiling, and 4,096 output-token ceiling reserve less than
$10 even at the full cap. Do not use its resulting artifact as
production configuration before the decisions are sampled and adopted into the
versioned compatibility contract.

The runner creates `catalog-compatibility.progress.json` after each completed
batch and removes it only after writing the final artifact. That progress file is
an interrupted-run recovery aid, not evidence to publish or configure from.

Read the [study report](../../docs/review-exercise-identity-2026-09-08.md) and
[proposed implementation specification](../../docs/exercise-identity-implementation.md).
