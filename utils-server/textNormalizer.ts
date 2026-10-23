/**
 * textNormalizer.ts — Stage 007 §2–§3 six-stage orthographic normalizer.
 *
 * NORMATIVE ORDER: scrubPii (imported cross-stage contract from
 * utils-server/vendorClientWrapper.ts, F-007-4) runs FIRST — before
 * clustering and before any logging — then NFC/invisible-glyph cleaning,
 * Bengali orthographic canonicalization, numeral folding, elongation
 * reduction + casefolding, tokenization/Dhaka abbreviation expansion, and
 * ordered entity extraction + phonetic parsing.
 *
 * Every output carries normalizer_version / ruleset_version so 90-day
 * ledger replays reproduce the exact ruleset.
 *
 * Deviation note: plan §3 shows `import crypto from 'crypto'`; this file
 * uses `import { createHash } from 'node:crypto'` — semantically identical
 * SHA-256, explicit specifier, no esModuleInterop dependency.
 */

import { createHash } from 'node:crypto';
import { scrubPii } from './vendorClientWrapper';
import { extractEntities } from './entityLocker';
import { generateBengaliPhoneticKey } from './bengaliPhonetics';

export const NORMALIZER_VERSION = 'norm-v2.1.0';
export const RULESET_VERSION = 'rule-2026.11';

/** Raw rider input bound at selection time (plan §2). */
export const MAX_RAW_QUERY_CHARS = 80;

const BENGALI_DIGIT_MAP: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

const DHAKA_ABBREVIATIONS: Record<string, string> = {
  'rd': 'road', 'st': 'street', 'ave': 'avenue', 'sec': 'sector', 'blk': 'block',
  'h': 'hospital', 'med': 'medical', 'clg': 'college', 'univ': 'university',
  'jfp': 'jamuna future park', 'dmc': 'dhaka medical college',
  'buet': 'bangladesh university of engineering and technology',
  'nsu': 'north south university', 'aiub': 'american international university bangladesh',
  'iub': 'independent university bangladesh', 'brac': 'brac university',
  'du': 'dhaka university', 'mrt': 'metro rail station',
};

export interface NormalizedQueryOutput {
  raw_query: string; // in-memory only; never persisted un-scrubbed
  scrubbed_query: string;
  normalized_query: string;
  normalized_tokens: string[];
  structured_entities: { headword: string; value: string }[]; // ORDERED (F-007-2)
  bound_directions: { anchor: string; direction: string }[]; // ORDERED (F-007-2)
  bengali_phonetic_key: string; // ≤ 120 chars (query_clusters VARCHAR(120))
  cluster_id: string;
  normalizer_version: string;
  ruleset_version: string;
}

export function normalizeSearchQuery(rawQuery: string): NormalizedQueryOutput {
  const raw = (rawQuery ?? '').slice(0, MAX_RAW_QUERY_CHARS);

  // Step 0: PII scrub FIRST (F-007-4 / Hard Rule 8 order).
  const scrubbed = scrubPii(raw);
  let text = scrubbed;

  // Step 1: NFC & invisible glyphs — strip ZWSP (U+200B), ZWNJ (U+200C),
  // ZWJ (U+200D), BOM/ZWNBSP (U+FEFF), soft hyphen (U+00AD); strip Bengali
  // Dari danda (U+0964) and double danda (U+0965).
  text = text.normalize('NFC');
  text = text.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '');
  text = text.replace(/[\u0964\u0965]/g, ' ');

  // Step 2: orthographic canonicalization — Ta+Hasant (U+09A4 U+09CD) →
  // Khanda-Ta (U+09CE); Chandrabindu (U+0981) optionality folding.
  // (Nukta pairs such as ড+U+09BC compose via the NFC above.)
  text = text.replace(/\u09A4\u09CD/g, '\u09CE');
  text = text.replace(/\u0981/g, '');

  // Step 3: numeral folding (idempotent; scrubPii already folded once).
  text = text.replace(/[০-৯]/g, (m) => BENGALI_DIGIT_MAP[m] || m);

  // Step 4: elongation reduction & casefolding (F-007-1: 3+ runs → 1;
  // genuine 2-char geminates preserved).
  text = text.toLowerCase();
  text = text.replace(/(.)\1{2,}/g, '$1'); // "jammmuuuna" → "jamuna"; "ss" kept
  text = text.replace(/[^a-z0-9\u0980-\u09FF\s]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  // Step 5: tokenization & abbreviation expansion.
  const rawTokens = text.split(' ').filter((t) => t.length > 0);
  const normalizedTokens: string[] = rawTokens.map((t) => DHAKA_ABBREVIATIONS[t] || t);

  // Step 6: ordered entity extraction + phonetic parsing.
  const { structuredEntities, boundDirections } = extractEntities(normalizedTokens);

  const normalizedQuery = normalizedTokens.join(' ');
  const phoneticKey = generateBengaliPhoneticKey(normalizedTokens);

  // Cluster identity: phonetic key + ORDERED entity pairs + ORDERED
  // direction bindings. Permutations ("gate 1 road 2" vs "road 1 gate 2")
  // produce different cluster_ids.
  const entitySig = structuredEntities.map((e) => `${e.headword}:${e.value}`).join(',');
  const dirSig = boundDirections.map((d) => `${d.anchor}:${d.direction}`).join(',');
  const clusterPayload = `${phoneticKey}|${entitySig}|${dirSig}|${NORMALIZER_VERSION}|${RULESET_VERSION}`;
  const cluster_id =
    'cl_' + createHash('sha256').update(clusterPayload).digest('hex').substring(0, 16);

  return {
    raw_query: raw,
    scrubbed_query: scrubbed,
    normalized_query: normalizedQuery,
    normalized_tokens: normalizedTokens,
    structured_entities: structuredEntities,
    bound_directions: boundDirections,
    bengali_phonetic_key: phoneticKey,
    cluster_id,
    normalizer_version: NORMALIZER_VERSION,
    ruleset_version: RULESET_VERSION,
  };
}
