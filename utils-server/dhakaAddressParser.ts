/**
 * dhakaAddressParser.ts — Stage 013 section 3 clean-room Dhaka compound parser.
 *
 * Deconstructs compound addresses ("Flat 5B, House 23/A, Road 4, Block C,
 * Sector 11, Uttara, Dhaka-1230") into:
 *   - delivery_notes: private micro-units (flat/unit, holding/house — Latin
 *     AND Bengali) for the DRIVER HANDSET ONLY. Ephemeral per-trip display;
 *     never in dpmaps.*, purged with trip records (Stage 011 Class 1).
 *   - resolvable_query: ordered public anchors (road/lane, block/sector,
 *     area/thana, postal) for MeiliSearch — micro-units stripped first
 *     (zero-hit prevention: "Road 4 Block C Uttara").
 *
 * Stage 007 hand-off: scrubPii runs FIRST (phones/emails out, Bengali
 * digits folded — TC-013-02), and the resolvable tokens feed
 * extractEntities so "Road 4" and "Road 7" stay distinct ordered entities.
 *
 * Zero dependencies beyond the repo (vendorClientWrapper, entityLocker).
 */

import { scrubPii } from './vendorClientWrapper';
import { extractEntities } from './entityLocker';

export interface ParsedDhakaAddress {
  /** Raw input (in-memory only; never persisted un-scrubbed). */
  raw_input: string;
  /** Scrubbed + normalized working text. */
  scrubbed_input: string;
  /** Ephemeral driver-handset notes (Class 1 — NEVER persisted). */
  delivery_notes: string[];
  /** Ordered public anchors for search/geocode. */
  resolvable_query: string;
  /** Ordered (headword, value) entity pairs from Stage 007 (Road 4 ≠ Road 7). */
  structured_entities: { headword: string; value: string }[];
  postal_code?: string;
}

/** Micro-unit markers: flat/unit + holding/house, Latin + Bengali. */
const MICRO_UNIT_PATTERNS: RegExp[] = [
  /\bflat\s*[a-z]?\d*[a-z]?(?:\s*[-/]\s*[a-z]?\d*[a-z]?)?/i,
  /\bunit\s*[a-z]?\d*[a-z]?/i,
  /\bhouse\s*\d*[a-z]?(?:\s*[-/]\s*\d*[a-z]?)?/i,
  /\bholding\s*\d*[a-z]?(?:\s*[-/]\s*\d*[a-z]?)?/i,
  /ফ্ল্যাট\s*[০-৯0-9a-zA-Z]*/,
  /ফ্লোর\s*[০-৯0-9a-zA-Z]*/,
  /[০-৯0-9]+\s*তলা/,
  /বাড়ি(\s*নং\s*[০-৯0-9/]+)?/,
  /হোল্ডিং\s*[০-৯0-9/]+/,
  /বাসা(\s*নং\s*[০-৯0-9/]+)?/,
];

/** Resolvable anchor markers (kept, ordered). */
const ROAD_PATTERNS: RegExp[] = [
  /\broad\s*\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?/i,
  /\blane\s*\d*[a-z]?/i,
  /\bgoli\s*\d*[a-z]?/i,
  /গলি(\s*[০-৯0-9]+)?/,
  /রোড(\s*[০-৯0-9]+[a-z০-৯]?)?/,
];
const BLOCK_SECTOR_PATTERNS: RegExp[] = [
  /\bblock\s*[a-z]/i,
  /\bsector\s*\d+/i,
  /ব্লক\s*[অ-হa-zA-Z]/,
  /সেক্টর\s*[০-৯0-9]+/,
];
const POSTAL_PATTERNS: RegExp[] = [/\bdhaka[-\s]?(\d{4})\b/i, /\b(\d{4})\b/];

/** Dhaka area/thana token list (shared with the Stage 010 Road-N heuristic). */
const AREA_TOKENS = new Set(
  [
    'uttara', 'dhanmondi', 'gulshan', 'banani', 'mirpur', 'mohakhali', 'badda',
    'khilgaon', 'bashundhara', 'baridhara', 'wari', 'lalmatia', 'mohammadpur',
    'shyamoli', 'tejgaon', 'pallabi', 'kafrul', 'jatrabari', 'motijheel',
    'paltan', 'ramna', 'tejgoan', 'uttara', 'dakshin', 'khilkhet', 'cantonment',
    'bashundhara', 'nikunja', 'bashabo', 'shahbag', 'dhanmondi', 'kalabagan',
    'ধানমন্ডি', 'গুলশান', 'বনানী', 'মিরপুর', 'উত্তরা', 'বাড্ডা', 'খিলগাঁও',
  ].map((t) => t.toLowerCase())
);

function matchAny(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const rx of patterns) {
    const m = text.match(rx);
    if (m && m[0].trim().length > 0) out.push(m[0].trim());
  }
  return out;
}

/**
 * Plan section 3 entry point. Scrub-first, then micro-unit extraction for
 * the handset, then ordered anchors for search.
 */
export function parseDhakaCompoundAddress(input: string): ParsedDhakaAddress {
  const raw = (input ?? '').slice(0, 200);
  // Stage 007 hand-off: scrubPii FIRST — phones/emails dropped, Bengali
  // digits folded to ASCII (TC-013-02: "বাড়ি নং ২৩" folds before matching).
  const scrubbed = scrubPii(raw);

  const delivery_notes: string[] = [];
  for (const note of matchAny(scrubbed, MICRO_UNIT_PATTERNS)) {
    if (!delivery_notes.includes(note)) delivery_notes.push(note);
  }

  // Resolvable anchors in canonical order: road/lane → block/sector →
  // area/thana → postal. Micro-unit segments never reach the query.
  const anchors: string[] = [];
  for (const a of matchAny(scrubbed, ROAD_PATTERNS)) anchors.push(a);
  for (const a of matchAny(scrubbed, BLOCK_SECTOR_PATTERNS)) anchors.push(a);
  const tokens = scrubbed.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 0);
  for (const t of tokens) {
    if (AREA_TOKENS.has(t)) {
      const orig = scrubbed.split(/[\s,]+/).find((w) => w.toLowerCase() === t);
      if (orig && !anchors.includes(orig)) anchors.push(orig);
    }
  }
  let postal: string | undefined;
  for (const rx of POSTAL_PATTERNS) {
    const m = scrubbed.match(rx);
    if (m && (m[1] ?? m[0])) {
      postal = m[1] ?? m[0];
      break;
    }
  }

  const resolvable_query = anchors.join(' ');
  // Ordered entity pairs keep "Road 4" distinct from "Road 7".
  const { structuredEntities } = extractEntities(resolvable_query.toLowerCase().split(/\s+/).filter((t) => t.length > 0));

  return {
    raw_input: raw,
    scrubbed_input: scrubbed,
    delivery_notes,
    resolvable_query,
    structured_entities: structuredEntities.map((e) => ({ headword: e.headword, value: e.value })),
    postal_code: postal,
  };
}
