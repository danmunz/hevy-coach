/** Isolated research prototype. No network, database, or production imports. */
import { createHash } from 'node:crypto';

export interface Template {
  id: string; title: string; type: string; equipment: string;
  primary_muscle_group: string; secondary_muscle_groups: string[]; is_custom: boolean;
}
export type Status = 'compatible' | 'incompatible' | 'unresolved';
export interface Decision { status: Status; id?: string; reason: string; candidates: string[] }
export interface Profile { barbell: boolean; dumbbell: boolean; pulley: boolean; pullupBar: boolean; rope?: boolean }
// Manually extracted facts, not an automatic equipment-description parser.
export const homeGym: Profile = { barbell: true, dumbbell: true, pulley: true, pullupBar: true };

export function key(name: string): string {
  return name.toLowerCase().replace(/\bdb\b/g, 'dumbbell')
    .replace(/\btriceps\b/g, 'tricep').replace(/\bbiceps\b/g, 'bicep')
    .replace(/[-_()]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^dumbbell (.+)$/, '$1 dumbbell');
}

// Overrides identify a movement; they do not assert equipment compatibility.
// OHP/bench defaults follow this account's barbell program, not universal synonyms.
export const aliases: Record<string, string> = {
  ohp: '7B8D84E8', bench: '79D0BB3A', 'bench press': '79D0BB3A',
  squat: 'D04AC939', deadlift: 'C6272009', 'overhead press': '7B8D84E8',
  'good morning': '4180C405', 'seated row': 'F1D60854',
  'seated row v grip': '0393F233', 'lat pulldown': '6A6C31A5',
};

export function compatibility(t: Template, p: Profile): { status: Status; reason: string } {
  const title = key(t.title);
  if (/\bdips?\b/.test(title)) return { status: 'incompatible', reason: 'Equipment description explicitly excludes all dips.' };
  if (t.id === '94B7239B') return p.rope === true && p.pulley
    ? { status: 'compatible', reason: 'Pulley and rope explicitly confirmed.' }
    : { status: 'unresolved', reason: 'Rope attachment is not listed; cannot substitute the bar implicitly.' };
  if (/stability ball|crossovers|landmine|suspension|ring|seal row|decline/.test(title)) {
    return { status: 'unresolved', reason: 'Additional attachment, geometry, or equipment requirement is unverified.' };
  }
  if (t.is_custom) return { status: 'unresolved', reason: 'Custom template requires a reviewed account-specific interpretation.' };
  // IDs corroborated by inventory/program. Deliberately not all barbell/DB exercises.
  const barbell = ['7B8D84E8', '79D0BB3A', 'D04AC939', 'C6272009', '4180C405', '5046D0A9'];
  const dumbbell = ['3601968B', '422B08F1', '07B38369', 'F1E57334'];
  const pulley = ['F1D60854', '0393F233', '6A6C31A5', '93A552C6', 'BE640BA0', 'BE289E45'];
  const requirement = barbell.includes(t.id) ? p.barbell : dumbbell.includes(t.id) ? p.dumbbell
    : pulley.includes(t.id) ? p.pulley : ['1B2B1E7C', '08590920'].includes(t.id) ? p.pullupBar : undefined;
  if (requirement !== undefined) return { status: requirement ? 'compatible' : 'incompatible', reason: requirement
    ? 'Movement supported by documented equipment/program.' : 'Required equipment explicitly removed.' };
  if (['5E1A7777', '392887AA', 'C6C9B8A0'].includes(t.id)) return { status: 'compatible', reason: 'Basic floor/bodyweight movement.' };
  // Live catalog labels cable exercises as machine. Never reject that entire category.
  if (/\(machine\)|smith machine/.test(t.title.toLowerCase())) return { status: 'incompatible', reason: 'Dedicated machine absent from this gym.' };
  return { status: 'unresolved', reason: 'Category alone does not establish complete movement requirements.' };
}

export function resolve(catalog: Template[], query: string, options: {
  id?: string; profile?: Profile; history?: boolean; requestedEquipment?: string;
} = {}): Decision {
  const k = key(query);
  const id = options.id ?? aliases[k];
  const candidates = id ? catalog.filter(t => t.id === id) : catalog.filter(t => {
    const tk = key(t.title);
    return tk === k;
  });
  if (candidates.length !== 1) return { status: 'unresolved', reason: id ? 'Bound ID absent or duplicated; never rebind by title.'
    : candidates.length > 1 ? 'Multiple identities share this name.' : 'No unique identity; retrieve candidates or clarify.',
    candidates: candidates.map(t => t.id) };
  const t = candidates[0];
  if (options.requestedEquipment && options.requestedEquipment !== t.equipment) return {
    status: 'unresolved', reason: 'Requested implement differs from template; adaptation requires an explicit logging decision.', candidates: [t.id] };
  const verdict = options.history ? { status: 'compatible' as const, reason: 'Historical ID lookup does not require present equipment.' }
    : compatibility(t, options.profile ?? homeGym);
  return { ...verdict, id: verdict.status === 'compatible' ? t.id : undefined, candidates: [t.id] };
}

export const revision = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class CatalogStore {
  constructor(public templates: Template[]) { this.validate(templates); }
  private validate(next: Template[]): void {
    if (!next.length || new Set(next.map(t => t.id)).size !== next.length || next.some(t => !t.id || !t.title)) throw new Error('Invalid catalog');
  }
  async refresh(fetcher: () => Promise<{ complete: boolean; templates: Template[] }>): Promise<void> {
    const next = await fetcher();
    if (!next.complete) throw new Error('Incomplete catalog');
    this.validate(next.templates);
    this.templates = next.templates;
  }
}

export interface BoundExercise { templateId: string; titleAtSelection: string }
export function bind(t: Template): BoundExercise { return { templateId: t.id, titleAtSelection: t.title }; }
export function captureWrite(exercise: BoundExercise, catalog: Template[], profile = homeGym): { exercise_template_id: string } {
  const result = resolve(catalog, exercise.titleAtSelection, { id: exercise.templateId, profile });
  if (result.status !== 'compatible' || !result.id) throw new Error(result.reason);
  return { exercise_template_id: result.id };
}
export function migrateLegacy(name: string, confirmedIds: Record<string, string>, catalog: Template[]): BoundExercise | undefined {
  const id = confirmedIds[name];
  const t = id ? catalog.find(t => t.id === id) : undefined;
  return t ? bind(t) : undefined; // Today's alias table cannot prove yesterday's selection.
}
