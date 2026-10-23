/**
 * residentialPrivacy.ts — Stage 011 §§2–3 privacy guardrails & residential boundary.
 *
 * Four absolute banned classes (categorical invariants, not regex suggestions):
 *   Class 1 — unit-level specifics ("Flat 4B", "Suite 301", "৪র্থ তলা"):
 *              DROPPED at ingestion, never learnable.
 *   Class 2 — personal/relationship names ("Mamur bari", "Rahim er basha"):
 *              private history only, never public.
 *   Class 3 — saved personal places (Home/Work/Gym): per-user sovereign
 *              places only (Stage 014); never in the learning pool.
 *   Class 4 — rider↔place linkage: no endpoint joins riders to places;
 *              retention facts only (135-day keys / 90-day ledger / 30-day
 *              raw purge — Stage 003 §§4.4/5.2, asserted as constants).
 *
 * Public Landmark Convergence Rule (F-011-4): a named building may index as
 * point_type='building' ONLY when the NAME converges across many unrelated
 * riders (≥15 riders, ≥5 drivers, ≥3 weeks, ≤30m spread, clean name —
 * all [ESTIMATE]). Unit/personal content is barred at ANY convergence
 * (TC-011-13). Single-family homes fail diversity and stay unindexed.
 *
 * Reuses the Stage 010 sanitizer (which already rejects residential input)
 * and maps its verdicts onto the four classes. Zero DB deps.
 */

import { sanitizeAndFormatDisplayName } from '../utils-server/namingSanitizer';

export type PrivacyClass = 'class_1_unit' | 'class_2_personal' | 'class_3_saved_place' | null;
export type PrivacyAction = 'drop' | 'private_only' | 'allow';

export interface PrivacyVerdict {
  action: PrivacyAction;
  privacyClass: PrivacyClass;
  reason: string;
}

/** Retention facts (Stage 003 §§4.4/5.2) — code-visible, not just docs. */
export const RETENTION_FACTS = {
  windowKeyLifetimeDays: 135,
  keyRotationDays: 30,
  evidenceWindowDays: 90,
  rawLogPurgeDays: 30,
} as const;

/** K-anonymity floor (§2.1.4): <5 unique riders/90d ⇒ snap to junction, never a curb pin. */
export const K_ANONYMITY_FLOOR_RIDERS = 5;

/** Class 1: unit-level specifics (Latin + Bengali markers). */
const UNIT_PATTERNS: RegExp[] = [
  /\bflat\b/i,
  /\bapt\b\.?/i,
  /\bapartment\b/i,
  /\bsuite\b/i,
  /\bfloor\b/i,
  /\btola\b/i,
  /তলা/,
  /ফ্ল্যাট/,
  /ফ্লোর/,
  /অ্যাপার্টমেন্ট/,
  /\broom\s*(no\.?|number|#)?\s*\w*\d+/i,
  /রুম\s*\d/,
  /\b\d+\s*(st|nd|rd|th)?\s*(floor|তলা)\b/i,
  /[০-৯]+\s*(তলা)/,
];

/**
 * Class 2: personal/relationship names.
 * Familial anchors + residence markers, or a personal-name shape
 * ("<Name> er bari/basha") — private history only.
 */
const PERSONAL_PATTERNS: RegExp[] = [
  /m[ae]mur/i,
  /kh[ae]lur/i,
  /ch[ae]ch[ae]?r/i,
  /b[ae]b[ae]?r\s+er/i,
  /m[ae](y)?er\s+(bari|basha|basa)/i,
  /bh[ae]iyer\s+(bari|basha|basa)/i,
  /boner\s+(bari|basha|basa)/i,
  /\bdr\.?\s+[A-Z\u0980-\u09FF]/,
  /\brah+i+m\b/i,
  /^\s*[A-Z\u0980-\u09FF][a-z\u0980-\u09FF]+\s+er\s+(bari|basha|basa)\b/,
  /\b(bari|basha|basa)\b/i,
];

/** Class 3: saved personal-place labels — whole-phrase match only. */
const SAVED_PLACE_LABELS: RegExp[] = [
  /^\s*(my\s+)?home\s*$/i,
  /^\s*(my\s+)?work\s*$/i,
  /^\s*(my\s+)?office\s*$/i,
  /^\s*(my\s+)?gym\s*$/i,
  /^\s*parents?\s*$/i,
  /^\s*বাড়ি\s*$/,
  /^\s*বাসা\s*$/,
];

/**
 * Classify raw rider text into the four banned classes.
 * Returns { action:'allow' } only when no class matches AND the
 * Stage 010 sanitizer accepts the string.
 */
export function classifyPrivacy(rawInput: string): PrivacyVerdict {
  const text = (rawInput ?? '').trim();
  if (text.length === 0) return { action: 'drop', privacyClass: 'class_1_unit', reason: 'empty' };

  for (const rx of SAVED_PLACE_LABELS) {
    if (rx.test(text)) {
      return { action: 'private_only', privacyClass: 'class_3_saved_place', reason: 'saved-personal-label' };
    }
  }
  for (const rx of UNIT_PATTERNS) {
    if (rx.test(text)) {
      return { action: 'drop', privacyClass: 'class_1_unit', reason: 'unit-level-specific' };
    }
  }
  for (const rx of PERSONAL_PATTERNS) {
    if (rx.test(text)) {
      return { action: 'private_only', privacyClass: 'class_2_personal', reason: 'personal-relationship-name' };
    }
  }
  // Belt-and-braces: the Stage 010 sanitizer's own residential rejection
  // (its patterns are a superset for mixed-script shapes).
  const s = sanitizeAndFormatDisplayName(text);
  if (!s.valid && s.rejection_reason === 'residential') {
    return { action: 'private_only', privacyClass: 'class_2_personal', reason: 'sanitizer-residential' };
  }
  if (!s.valid) {
    return { action: 'drop', privacyClass: 'class_1_unit', reason: `sanitizer-${s.rejection_reason ?? 'invalid'}` };
  }
  return { action: 'allow', privacyClass: null, reason: 'clean' };
}

/** Learning-pool gate: only 'allow' verdicts may enter public ingestion. */
export function isLearnableForPublicPool(rawInput: string): boolean {
  return classifyPrivacy(rawInput).action === 'allow';
}

/** Convergence inputs (F-011-4) — all five criteria, all [ESTIMATE]. */
export interface ConvergenceEvidence {
  distinctRiders: number;
  distinctDrivers: number;
  activeWeeks: number;
  /** DBSCAN entrance-cluster spread in meters. */
  maxSpreadMeters: number;
  /** Candidate display name (checked for barred content first). */
  candidateName: string;
}

export const CONVERGENCE_THRESHOLDS = {
  minRiders: 15,
  minDrivers: 5,
  minWeeks: 3,
  maxSpreadMeters: 30,
} as const;

export interface ConvergenceOutcome {
  indexable: boolean;
  pointType: 'building' | null;
  reason:
    | 'convergent-landmark'
    | 'categorically-barred'
    | 'insufficient-diversity'
    | 'insufficient-weeks'
    | 'spatial-scatter';
}

/**
 * F-011-4 rule engine. Barred content is checked FIRST: unit/personal
 * strings stay out at ANY convergence level (TC-011-13).
 */
export function evaluateConvergence(ev: ConvergenceEvidence): ConvergenceOutcome {
  // Any banned class (or any sanitizer reject) bars publication —
  // convergence volume never overrides the categorical boundary.
  if (classifyPrivacy(ev.candidateName).action !== 'allow') {
    return { indexable: false, pointType: null, reason: 'categorically-barred' };
  }
  if (ev.distinctRiders < CONVERGENCE_THRESHOLDS.minRiders) {
    return { indexable: false, pointType: null, reason: 'insufficient-diversity' };
  }
  if (ev.distinctDrivers < CONVERGENCE_THRESHOLDS.minDrivers) {
    return { indexable: false, pointType: null, reason: 'insufficient-diversity' };
  }
  if (ev.distinctRiders < K_ANONYMITY_FLOOR_RIDERS) {
    return { indexable: false, pointType: null, reason: 'insufficient-diversity' };
  }
  if (ev.activeWeeks < CONVERGENCE_THRESHOLDS.minWeeks) {
    return { indexable: false, pointType: null, reason: 'insufficient-weeks' };
  }
  if (ev.maxSpreadMeters > CONVERGENCE_THRESHOLDS.maxSpreadMeters) {
    return { indexable: false, pointType: null, reason: 'spatial-scatter' };
  }
  return { indexable: true, pointType: 'building', reason: 'convergent-landmark' };
}
