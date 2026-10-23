/**
 * bengaliPhonetics.ts — Stage 007 §4 Bengali/Banglish phonetic engine.
 *
 * South Asian phoneme equivalence across Bengali script and Latin
 * transliteration, feeding dpmaps.query_clusters.bengali_phonetic_key
 * (VARCHAR(120)) and the Stage 008 Meili feed (bengali_phonetic_keys[]).
 *
 * Longest-match 3/2/1-char table over lowercased tokens, adjacent-duplicate
 * collapse, initial-vowel 'A' marker (once), digits skipped (they ride in
 * structured entities). Name-token parts are SORTED (order-insensitive per
 * user decision DPM-§7-refinement): "Star Kabab Banani" and
 * "Banani Star Kabab" share one key. Digit/gate locking is unaffected —
 * structured pairs and direction bindings stay ORDERED in the cluster
 * payload (textNormalizer + entityLocker).
 *
 * Documented simplifications [ESTIMATE — validate on real query corpus]:
 * aspiration-neutral merges, inherent-vowel elision except initial, no
 * schwa-deletion heuristics. The key is high-recall candidate matching;
 * precision comes from digit/direction locking + spatial convergence.
 * Western Soundex/Double Metaphone are NOT used (fail on Bengali
 * aspiration pairs and retroflex/dental distinctions).
 */

const PHONETIC_MAP: Record<string, string> = {
  'ক': 'K', 'খ': 'K', 'গ': 'G', 'ঘ': 'G', 'ঙ': 'N',
  'চ': 'C', 'ছ': 'C', 'জ': 'J', 'ঝ': 'J', 'ঞ': 'N',
  'ট': 'T', 'ঠ': 'T', 'ড': 'D', 'ঢ': 'D', 'ণ': 'N',
  'ত': 'T', 'থ': 'T', 'দ': 'D', 'ধ': 'D', 'ন': 'N',
  'প': 'P', 'ফ': 'P', 'ব': 'B', 'ভ': 'B', 'ম': 'M',
  'য': 'J', 'র': 'R', 'ল': 'L', 'শ': 'S', 'ষ': 'S',
  'স': 'S', 'হ': 'H', 'ড়': 'R', 'ঢ়': 'R', 'য়': 'Y',
  'ৎ': 'T', 'ং': 'N', 'ঃ': 'H',
  'kh': 'K', 'gh': 'G', 'ch': 'C', 'chh': 'C', 'jh': 'J',
  'th': 'T', 'dh': 'D', 'ph': 'P', 'bh': 'B', 'sh': 'S',
  'k': 'K', 'c': 'K', 'q': 'K', 'g': 'G', 'j': 'J', 'z': 'J',
  't': 'T', 'd': 'D', 'p': 'P', 'f': 'P', 'b': 'B', 'v': 'B',
  'w': 'B', 'm': 'M', 'n': 'N', 'r': 'R', 'l': 'L', 's': 'S',
  'h': 'H', 'y': 'Y',
};

/** Max length of query_clusters.bengali_phonetic_key (Stage 003 §4.x). */
export const PHONETIC_KEY_MAX_LEN = 120;

export function generateBengaliPhoneticKey(tokens: string[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) continue; // digits ride in structured entities
    let key = '';
    let i = 0;
    let firstVowelRetained = false;
    while (i < token.length) {
      const sub3 = token.substring(i, i + 3);
      const sub2 = token.substring(i, i + 2);
      const sub1 = token.substring(i, i + 1);
      if (PHONETIC_MAP[sub3]) { key += PHONETIC_MAP[sub3]; i += 3; }
      else if (PHONETIC_MAP[sub2]) { key += PHONETIC_MAP[sub2]; i += 2; }
      else if (PHONETIC_MAP[sub1]) { key += PHONETIC_MAP[sub1]; i += 1; }
      else {
        // Initial-vowel retention (F-007-3): an UNMAPPED leading vowel letter
        // is retained as an 'A' marker once. (Plan §4 prose; the plan code
        // block misplaced this check inside the mapped branch — where vowels
        // never occur — and omitted the single-char append. Repaired here so
        // the documented Dhanmondi ↔ ধানমন্ডি → DNMND acceptance holds.)
        if (!firstVowelRetained && key === '' && /[aeiouao]/.test(sub1)) {
          key += 'A'; firstVowelRetained = true;
        }
        i += 1;
      }
    }
    key = key.replace(/(.)\1+/g, '$1'); // collapse duplicates
    if (key.length > 0) parts.push(key);
  }
  // Order-insensitive name tokens (user decision 2026-10-22).
  return parts.sort().join('_').slice(0, PHONETIC_KEY_MAX_LEN);
}
