/**
 * namingSanitizer.ts — Stage 010 §5 multi-stage sanitizer & PII firewall.
 *
 * Pipeline (plan order):
 *   Raw Candidate → scrubPii FIRST (F-010-5) → length 3–80 → PII residue →
 *   residential classes (REJECT, never strip-and-publish) → obscenity lexicon →
 *   commercial spam → clutter stripping → Road-N heuristic → title-case +
 *   abbreviation expansion → bilingual split + dictionary-quality completion.
 *
 * Divergence note: plan §5 shows `import { scrubPii } from './textNormalizer'`.
 * textNormalizer.ts does not export scrubPii — the cross-stage contract lives
 * in utils-server/vendorClientWrapper.ts (Stage 002 §2.2, re-affirmed by the
 * Stage 007 header). This file imports from the real contract location;
 * behavior is identical (same function, same order).
 *
 * Zero dependencies beyond the repo (vendorClientWrapper, bilingualCivicDictionary).
 */

import { scrubPii } from './vendorClientWrapper';
import { generateBilingualCounterpart } from './bilingualCivicDictionary';

export interface SanitizedNameResult {
  valid: boolean;
  canonical_name?: string;
  bangla_name?: string;
  rejection_reason?: 'length' | 'pii' | 'residential' | 'profanity' | 'spam';
}

/** Display-name bound (plan §5 step 1; post_trip_labels is VARCHAR(120),
 *  but published display names stay within the 80-char rider-input bound). */
export const DISPLAY_NAME_MIN_LEN = 3;
export const DISPLAY_NAME_MAX_LEN = 80;

/** PII residue after scrubPii (belt-and-braces — scrubPii runs first). */
const PII_RESIDUE_PATTERNS: RegExp[] = [
  /\+?88?01[3-9]\d{8}/, // any surviving BD mobile shape
  /\b\d{9,}\b/, // long digit run (delimited phones already separator-stripped)
  /[^\s@]+@[^\s@]+\.[^\s@]+/, // surviving email shape
];

/**
 * Stage 011 privacy classes — CATEGORICAL reject (plan §5).
 * Unit/flat/floor markers, Home/Work labels, relationship phrases
 * ("Mamur bari"), resident/family name shapes. Never strip-and-publish:
 * a hit rejects the whole candidate.
 */
const RESIDENTIAL_PATTERNS: RegExp[] = [
  /\bflat\b/i,
  /\bunit\b/i,
  /\bfloor\b/i,
  /\bapartment\b/i,
  /\btola\b/i,
  /\b(room|suite)\s*(no\.?|number|#)?\s*\d+/i,
  /^\s*(home|work)\s*$/i,
  /\bmy\s+(home|work|house|flat|room)\b/i,
  /^(home|work)\b/i,
  /\b(bari|basha|basa|badi)\b/i, // relationship/residence marker — needs human review, never auto-publish
  /(mamur|mamar|khalur|chachar|chachir|babar|maer|bhaiyer|boner|sasurir|kh0601lur)\s*(bari|basha|basa)/i,
];

/**
 * Obscenity lexicon (bn/banglish/en). Production list is admin-maintained
 * (system_config); this ships the structural gate + seed entries.
 * Seed set kept small and unambiguous; extend via review, not ad hoc.
 */
const OBSCENITY_PATTERNS: RegExp[] = [
  /\bf+u+c+k+\b/i,
  /\bs+h+i+t+\b/i,
  /\bb+i+t+c+h+\b/i,
  /\bc+h+o+d+\b/i, // banglish slur stem
  /খানকি/,
  /চোদ/,
];

/** Commercial spam shapes. */
const SPAM_PATTERNS: RegExp[] = [
  /to[\s-]*let/i,
  /\bcall\s+now\b/i,
  /\bfor\s+(sale|rent)\b/i,
  /\b(viber|whatsapp|imo)\b/i,
  /\bdiscount\b/i,
  /\bpromo\b/i,
  /\boffer\s+now\b/i,
  /017\d{8}|01[3-9]\d{8}/,
];

/**
 * Conversational clutter — suffix AND standalone-phrase stripping
 * (plan §5: "er samne", "er pashe", "er kache", "er ultapash",
 * "opposite to", Bangla equivalents included).
 * Stripped iteratively from the END of the string only.
 */
const CLUTTER_SUFFIXES: RegExp[] = [
  /\s+er\s+(samne|pashe|pase|kache|kachhe|ultapash|ultodike|opposite)\s*$/i,
  /\s+(samne|pashe|pase|kache|kachhe)\s*$/i,
  /\s+opposite\s+(to|of)\b.*$/i,
  /\s+in\s+front\s+of\b.*$/i,
  /\s+near\s+.*$/i,
  /\s+এর\s+(সামনে|পাশে|কাছে|উল্টাপাশে)\s*$/,
  /\s+(সামনে|পাশে|কাছে)\s*$/,
];

export function stripClutter(text: string): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const rx of CLUTTER_SUFFIXES) {
      const next = out.replace(rx, '').trim();
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Known Dhaka area tokens for the structured "Road N" heuristic
 * (plan §5, fixes TC-010-02). [ESTIMATE heuristic — list maintained with
 * Stage 013; disable via setRoadNHeuristicEnabled(false) / system_config.]
 */
const ROAD_N_AREA_TOKENS = new Set(
  [
    'dhanmondi', 'gulshan', 'banani', 'mirpur', 'uttara', 'mohakhali',
    'badda', 'khilgaon', 'bashundhara', 'baridhara', 'wari', 'lalmatia',
    'mohammadpur', 'shyamoli', 'tejgaon', 'pallabi', 'kafrul', 'jatrabari',
    'ধানমন্ডি', 'গুলশান', 'বনানী', 'মিরপুর', 'উত্তরা',
  ].map((t) => t.toLowerCase())
);

let roadNHeuristicEnabled = true;
export function setRoadNHeuristicEnabled(v: boolean): void {
  roadNHeuristicEnabled = v;
}
export function isRoadNHeuristicEnabled(): boolean {
  return roadNHeuristicEnabled;
}

/**
 * "Dhanmondi 27" → "Dhanmondi Road 27": a bare numeral following a known
 * neighborhood/area token with no other entity headword expands Dhaka-style.
 */
export function applyRoadNHeuristic(text: string): string {
  if (!roadNHeuristicEnabled) return text;
  const m = text.match(/^(.+?)\s+(\d{1,3}[A-Za-z]?(?:\/\d{1,3})?)$/);
  if (!m) return text;
  const head = m[1].trim();
  const num = m[2];
  if (/road/i.test(head)) return text; // already structured
  const headTokens = head.split(/\s+/);
  if (headTokens.length !== 1) return text; // "no other entity headword"
  if (!ROAD_N_AREA_TOKENS.has(headTokens[0].toLowerCase())) return text;
  return `${head} Road ${num}`;
}

/** Dhaka abbreviation expansion before title-casing (TC-010-06: "Hosp"). */
const DISPLAY_ABBREVIATIONS: Record<string, string> = {
  hosp: 'Hospital',
  sq: 'Square',
  rd: 'Road',
  st: 'Street',
  ave: 'Avenue',
  sec: 'Sector',
  blk: 'Block',
  med: 'Medical',
  clg: 'College',
  univ: 'University',
  masjid: 'Masjid',
};

export function titleCaseExpand(text: string): string {
  return text
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((tok) => {
      const lower = tok.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (DISPLAY_ABBREVIATIONS[lower]) return DISPLAY_ABBREVIATIONS[lower];
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Plan §5 entry point (abridged signature kept; rejection reasons are a
 * granular superset of the plan's single 'pii/residential/profanity' bucket).
 */
export function sanitizeAndFormatDisplayName(rawInput: string): SanitizedNameResult {
  // F-010-5: PII first — delimited phones (017-1122-3344) are caught here
  // because scrubPii strips separators inside 10–13 digit runs before
  // dropping the BD mobile shape (TC-010-04b).
  const text0 = scrubPii(rawInput).trim().replace(/\s+/g, ' ');
  if (text0.length < DISPLAY_NAME_MIN_LEN || text0.length > DISPLAY_NAME_MAX_LEN) {
    return { valid: false, rejection_reason: 'length' };
  }
  for (const rx of PII_RESIDUE_PATTERNS) {
    if (rx.test(text0)) return { valid: false, rejection_reason: 'pii' };
  }
  for (const rx of RESIDENTIAL_PATTERNS) {
    if (rx.test(text0)) return { valid: false, rejection_reason: 'residential' };
  }
  for (const rx of OBSCENITY_PATTERNS) {
    if (rx.test(text0)) return { valid: false, rejection_reason: 'profanity' };
  }
  for (const rx of SPAM_PATTERNS) {
    if (rx.test(text0)) return { valid: false, rejection_reason: 'spam' };
  }

  let text = stripClutter(text0);
  if (text.length < DISPLAY_NAME_MIN_LEN) return { valid: false, rejection_reason: 'length' };
  text = applyRoadNHeuristic(text);

  const hasBengali = /[\u0980-\u09FF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);

  let canonical: string | undefined;
  let bangla: string | undefined;
  if (hasLatin) canonical = titleCaseExpand(text);
  if (hasBengali) bangla = text.normalize('NFC');

  // Bilingual completion (F-010-2): dictionary-quality counterpart fills the
  // gap; phonetic candidates do NOT enter display columns (aliases path).
  if (canonical && !bangla) {
    const g = generateBilingualCounterpart(canonical, 'en');
    if (g.quality === 'dictionary') bangla = g.generated;
  } else if (bangla && !canonical) {
    const g = generateBilingualCounterpart(bangla, 'bn');
    if (g.quality === 'dictionary') canonical = g.generated;
  }

  return { valid: true, canonical_name: canonical, bangla_name: bangla };
}
