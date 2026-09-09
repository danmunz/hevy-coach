import 'dotenv/config';

import { HevyClient } from '../src/hevy/client.js';
import { getCatalogStatus, importResearchDecisions, installExerciseCatalog, type CatalogDecision } from '../src/state/exercise-catalog.js';

const client = new HevyClient();
const catalog = await client.fetchAllTemplates(true);
const status = installExerciseCatalog(catalog);

let imported = 0;
try {
  const artifact = await import('./exercise-study/catalog-compatibility.review.json', { with: { type: 'json' } }) as {
    default: { decisions: Array<{ id: string; status: 'available' | 'unavailable' | 'review'; reason_code: string }> };
  };
  imported = importResearchDecisions(artifact.default.decisions.map(decision => ({
    templateId: decision.id, status: decision.status, reasonCode: decision.reason_code,
  } satisfies Omit<CatalogDecision, 'source'>)));
} catch (error) {
  console.warn(`[catalog] Research decision import skipped: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(JSON.stringify({ catalog: status, researchDecisionsImported: imported, current: getCatalogStatus() }, null, 2));
