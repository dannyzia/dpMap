/**
 * bilingualEngine.ts — Stage 010 §3 bilingual dual-name standard.
 *
 * Publication gate (F-010-2): `chk_poi_name_exists` needs ≥1 name
 * (candidates may be single-script); `chk_poi_bilingual_active` needs BOTH
 * canonical_name AND bangla_name at lifecycle_status='active'.
 * This module mirrors that CHECK in code so workers fail fast instead of
 * waiting for a constraint violation — the DB invariant stays authoritative.
 *
 * Completion rule (§3.3): a missing side is auto-filled ONLY from a
 * dictionary-quality counterpart. Phonetic candidates become
 * poi_aliases rows (alias_type 'transliteration', status 'pending') for
 * editorial review — never display columns.
 *
 * Zero dependencies beyond utils-server/bilingualCivicDictionary.ts.
 */

import { generateBilingualCounterpart } from '../utils-server/bilingualCivicDictionary';

export interface BilingualPair {
  canonical_name?: string;
  bangla_name?: string;
}

function nonEmpty(v: string | undefined): v is string {
  return !!v && v.trim().length > 0;
}

/**
 * Code mirror of `chk_poi_bilingual_active`:
 *   lifecycle_status <> 'active' OR (both names present).
 * Returns true when the pair may publish as 'active'.
 */
export function canPublishAsActive(pair: BilingualPair): boolean {
  return nonEmpty(pair.canonical_name) && nonEmpty(pair.bangla_name);
}

/** Code mirror of `chk_poi_name_exists` (≥1 name — candidate path). */
export function canExistAsCandidate(pair: BilingualPair): boolean {
  return nonEmpty(pair.canonical_name) || nonEmpty(pair.bangla_name);
}

export interface PendingTransliteration {
  alias_text: string;
  alias_type: 'transliteration';
  source: 'editorial';
  status: 'pending';
}

export interface BilingualCompletion extends BilingualPair {
  /** Phonetic fallback when the gap could not be dictionary-filled. */
  pendingAlias?: PendingTransliteration;
}

/**
 * Fill a single-script gap with a dictionary-quality counterpart.
 * Phonetic-quality output is returned as a pending alias, NOT a name.
 */
export function completeBilingualPair(pair: BilingualPair): BilingualCompletion {
  const { canonical_name, bangla_name } = pair;
  if (nonEmpty(canonical_name) && nonEmpty(bangla_name)) return { ...pair };
  if (nonEmpty(canonical_name) && !nonEmpty(bangla_name)) {
    const g = generateBilingualCounterpart(canonical_name, 'en');
    if (g.quality === 'dictionary') return { canonical_name, bangla_name: g.generated };
    return {
      canonical_name,
      pendingAlias: {
        alias_text: g.generated,
        alias_type: 'transliteration',
        source: 'editorial',
        status: 'pending',
      },
    };
  }
  if (nonEmpty(bangla_name) && !nonEmpty(canonical_name)) {
    const g = generateBilingualCounterpart(bangla_name, 'bn');
    if (g.quality === 'dictionary') return { canonical_name: g.generated, bangla_name };
    return {
      bangla_name,
      pendingAlias: {
        alias_text: g.generated,
        alias_type: 'transliteration',
        source: 'editorial',
        status: 'pending',
      },
    };
  }
  return {};
}

/** Display formatter: "canonical / bangla" when both exist. */
export function formatBilingualDisplay(pair: BilingualPair): string {
  const c = (pair.canonical_name ?? '').trim();
  const b = (pair.bangla_name ?? '').trim();
  if (c && b) return `${c} / ${b}`;
  return c || b || '';
}
