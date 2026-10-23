/**
 * bilingualCivicDictionary.ts — Stage 010 §3.3 wired bilingual counterpart generator.
 *
 * Curated civic-term dictionary (hospital/হাসপাতাল, mosque/মসজিদ, road/রোড,
 * sector/সেক্টর, gate/গেট, …) plus phonetic fallback for remaining tokens.
 *
 * Contract (plan §3.3):
 * - Every token mapped in the dictionary  → { quality: 'dictionary' }.
 *   Only dictionary-quality counterparts may enter canonical_name/bangla_name.
 * - Anything else → { quality: 'phonetic' } [ESTIMATE quality].
 *   Phonetic candidates enter poi_aliases (transliteration/pending) for
 *   editorial review — never straight into the display-name columns.
 *
 * Zero dependencies. Pure functions (testable without Postgres).
 */

export type ScriptSource = 'en' | 'bn';
export type CounterpartQuality = 'dictionary' | 'phonetic';

export interface BilingualCounterpart {
  generated: string;
  quality: CounterpartQuality;
}

/** Canonical civic term pair. `en` is the lowercase Latin slug form. */
interface CivicTerm {
  en: string;
  bn: string;
}

const CIVIC_TERMS: CivicTerm[] = [
  { en: 'hospital', bn: 'হাসপাতাল' },
  { en: 'mosque', bn: 'মসজিদ' },
  { en: 'masjid', bn: 'মসজিদ' },
  { en: 'jame', bn: 'জামে' },
  { en: 'road', bn: 'রোড' },
  { en: 'sector', bn: 'সেক্টর' },
  { en: 'gate', bn: 'গেট' },
  { en: 'school', bn: 'স্কুল' },
  { en: 'college', bn: 'কলেজ' },
  { en: 'university', bn: 'বিশ্ববিদ্যালয়' },
  { en: 'bank', bn: 'ব্যাংক' },
  { en: 'market', bn: 'মার্কেট' },
  { en: 'bazar', bn: 'বাজার' },
  { en: 'park', bn: 'পার্ক' },
  { en: 'station', bn: 'স্টেশন' },
  { en: 'hotel', bn: 'হোটেল' },
  { en: 'restaurant', bn: 'রেস্টুরেন্ট' },
  { en: 'pharmacy', bn: 'ফার্মেসি' },
  { en: 'medical', bn: 'মেডিকেল' },
  { en: 'area', bn: 'এলাকা' },
  { en: 'block', bn: 'ব্লক' },
  { en: 'avenue', bn: 'অ্যাভিনিউ' },
  { en: 'street', bn: 'স্ট্রিট' },
  { en: 'square', bn: 'স্কয়ার' },
  { en: 'future', bn: 'ফিউচার' },
  { en: 'jamuna', bn: 'যমুনা' },
  { en: 'dhanmondi', bn: 'ধানমন্ডি' },
  { en: 'gulshan', bn: 'গুলশান' },
  { en: 'banani', bn: 'বনানী' },
  { en: 'mirpur', bn: 'মিরপুর' },
  { en: 'uttara', bn: 'উত্তরা' },
];

/** Latin slug → Bengali. Bengali token → Latin (reverse lookup). */
const EN_TO_BN = new Map<string, string>();
const BN_TO_EN = new Map<string, string>();
for (const t of CIVIC_TERMS) {
  EN_TO_BN.set(t.en, t.bn);
  if (!BN_TO_EN.has(t.bn)) BN_TO_EN.set(t.bn, t.en);
}

function slugLatin(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugBengali(token: string): string {
  return token.replace(/[^\u0980-\u09FF]/g, '');
}

/** Split on whitespace; drop empties. Case preserved for output join. */
export function tokenize(name: string): string[] {
  return (name ?? '').split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Minimal Latin→Bengali phonetic fallback for unmapped tokens
 * [ESTIMATE — validate against the editorial review queue].
 * Character-level approximation; NOT publication quality.
 */
const LATIN_TO_BN_CHAR: Record<string, string> = {
  a: 'আ', b: 'ব', c: 'ক', d: 'ড', e: 'এ', f: 'ফ', g: 'গ',
  h: 'হ', i: 'ই', j: 'জ', k: 'ক', l: 'ল', m: 'ম', n: 'ন',
  o: 'ও', p: 'প', q: 'ক', r: 'র', s: 'স', t: 'ট', u: 'উ',
  v: 'ভ', w: 'ও', x: 'ক্স', y: 'ই', z: 'জ',
};

/**
 * Minimal Bengali→Latin phonetic fallback [ESTIMATE].
 * Aspirated/dental-retroflex pairs merge (same simplification class as
 * Stage 007 phonetic keys); precision comes from editorial review.
 */
const BN_TO_LATIN_CHAR: Record<string, string> = {
  'অ': 'a', 'আ': 'a', 'ই': 'i', 'ঈ': 'i', 'উ': 'u', 'ঊ': 'u',
  'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou',
  'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng',
  'চ': 'c', 'ছ': 'ch', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'n',
  'ট': 't', 'ঠ': 'th', 'ড': 'd', 'ঢ': 'dh', 'ণ': 'n',
  'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n',
  'প': 'p', 'ফ': 'ph', 'ব': 'b', 'ভ': 'bh', 'ম': 'm',
  'য': 'j', 'র': 'r', 'ল': 'l', 'শ': 'sh', 'ষ': 'sh',
  'স': 's', 'হ': 'h', 'ড়': 'r', 'ঢ়': 'rh', 'য়': 'y',
  'ৎ': 't', 'ং': 'ng', 'ঃ': 'h', 'ঁ': '',
};

function phoneticTransliterateToken(token: string, sourceScript: ScriptSource): string {
  if (sourceScript === 'en') {
    return token
      .toLowerCase()
      .split('')
      .map((c) => LATIN_TO_BN_CHAR[c] ?? c)
      .join('');
  }
  return token
    .split('')
    .map((c) => BN_TO_LATIN_CHAR[c] ?? (/[\u0980-\u09FF]/.test(c) ? '' : c))
    .join('')
    .replace(/^./, (m) => m.toUpperCase());
}

export function phoneticTransliterate(name: string, sourceScript: ScriptSource): string {
  return tokenize(name)
    .map((t) => phoneticTransliterateToken(t, sourceScript))
    .join(' ');
}

/**
 * Plan §3.3 verbatim-shaped generator.
 * Fully dictionary-mapped → 'dictionary'; otherwise phonetic fallback.
 */
export function generateBilingualCounterpart(
  name: string,
  sourceScript: ScriptSource
): BilingualCounterpart {
  const tokens = tokenize(name);
  if (tokens.length === 0) return { generated: '', quality: 'phonetic' };
  const mapped: (string | null)[] = tokens.map((t) => {
    if (sourceScript === 'en') return EN_TO_BN.get(slugLatin(t)) ?? null;
    const bn = slugBengali(t);
    if (bn.length === 0) return null;
    return BN_TO_EN.get(bn) ?? BN_TO_EN.get(t) ?? null;
  });
  // Bengali tokens may carry vowel signs — fall back to whole-token lookup.
  const fullyMapped = mapped.every((m) => m !== null);
  if (fullyMapped) return { generated: (mapped as string[]).join(' '), quality: 'dictionary' };
  // Partial dictionary coverage still yields phonetic overall (plan: the
  // remaining tokens go through phonetic transliteration). Per-token mixing
  // is an editorial decision, not an automatic one.
  return { generated: phoneticTransliterate(name, sourceScript), quality: 'phonetic' };
}
