import type { Status } from './reference.js';

export interface Case {
  id: string; group: string; query: string; expected: Status; expectedId?: string;
  evidence: string; variant?: 'rename' | 'duplicate' | 'removed' | 'adaptation';
}
// Expected answers are specified independently of resolver output.
// Cases are a designed regression set, not a random sample or held-out benchmark.
export const cases: Case[] = [
  { id: 'A1', group: 'alias', query: 'OHP', expected: 'compatible', expectedId: '7B8D84E8', evidence: 'Barbell main lift in program; existing Overhead Press mapping.' },
  { id: 'A2', group: 'alias', query: 'bench', expected: 'compatible', expectedId: '79D0BB3A', evidence: 'Barbell main/supplemental lift in program.' },
  { id: 'A3', group: 'alias', query: 'DB Bench Press', expected: 'compatible', expectedId: '3601968B', evidence: 'DB means dumbbell; bench and dumbbells listed. Load validation is separate.' },
  { id: 'A4', group: 'alias', query: 'Pull-Up', expected: 'compatible', expectedId: '1B2B1E7C', evidence: 'Punctuation variant; pull-up bar listed.' },
  { id: 'A5', group: 'alias', query: 'Good Morning', expected: 'compatible', expectedId: '4180C405', evidence: 'Program explicitly recommends good mornings; barbell available.' },
  { id: 'A6', group: 'alias', query: 'Tricep Pushdown', expected: 'compatible', expectedId: '93A552C6', evidence: 'Singular/plural alias; pulley supports tricep pushdowns explicitly.' },
  { id: 'E1', group: 'equipment', query: 'Seated Row', expected: 'compatible', expectedId: 'F1D60854', evidence: 'Explicit equipment.md bar-grip mapping.' },
  { id: 'E2', group: 'equipment', query: 'Seated Row (V Grip)', expected: 'compatible', expectedId: '0393F233', evidence: 'Explicit equipment.md triangle-attachment mapping.' },
  { id: 'E3', group: 'equipment', query: 'Seated Row (Machine)', expected: 'incompatible', evidence: 'No row machine; cable and machine identities remain distinct.' },
  { id: 'E4', group: 'equipment', query: 'Triceps Rope Pushdown', expected: 'unresolved', evidence: 'Rope attachment not listed. Absence is uncertainty, not proof the user lacks one.' },
  { id: 'E5', group: 'equipment', query: 'Cable Fly Crossovers', expected: 'unresolved', evidence: 'Upper/lower pulley description does not establish crossover geometry.' },
  { id: 'E6', group: 'equipment', query: 'Bench Dip', expected: 'incompatible', evidence: 'All dips explicitly excluded, including bench dips.' },
  { id: 'U1', group: 'ambiguity', query: 'row', expected: 'unresolved', evidence: 'Multiple movement and grip choices remain available.' },
  { id: 'U2', group: 'ambiguity', query: 'shoulder press', expected: 'unresolved', evidence: 'No explicit personal alias; catalog has several distinct shoulder/overhead press identities.' },
  { id: 'U3', group: 'ambiguity', query: 'Imaginary Quantum Curl', expected: 'unresolved', evidence: 'No such template in captured catalog; no ID may be fabricated.' },
  { id: 'U4', group: 'ambiguity', query: 'Crunch (Stability Ball)', expected: 'unresolved', evidence: 'Custom title implies ball; metadata says none; inventory does not list ball.' },
  { id: 'I1', group: 'identity', query: 'Bench Press (Barbell)', expected: 'compatible', expectedId: '79D0BB3A', variant: 'rename', evidence: 'Synthetic title change with same ID; historical identity remains stable.' },
  { id: 'I2', group: 'identity', query: 'Study Custom', expected: 'unresolved', variant: 'duplicate', evidence: 'Synthetic duplicate titles with different IDs cannot resolve uniquely.' },
  { id: 'I3', group: 'identity', query: 'Bird dogs', expected: 'unresolved', variant: 'removed', evidence: 'Synthetic removal of a known custom ID; old mapping must not authorize selection.' },
  { id: 'I4', group: 'identity', query: 'Dumbbell Row', expected: 'unresolved', variant: 'adaptation', evidence: 'KB adaptation allowed by inventory, but logging under a DB identity needs an explicit decision.' },
];

export const lifecycleCases = [
  { id: 'L1', group: 'lifecycle', evidence: 'Removing the barbell must invalidate a previously compatible selection.' },
  { id: 'L2', group: 'lifecycle', evidence: 'A renamed same-ID template retains identity; a recreated same-title template must not replace a missing bound ID.' },
  { id: 'L3', group: 'lifecycle', evidence: 'Network and incomplete-refresh failures preserve the last valid catalog and allow subsequent recovery.' },
  { id: 'L4', group: 'lifecycle', evidence: 'Legacy payloads require confirmed ID evidence; current aliases are insufficient to reconstruct old identity.' },
];
