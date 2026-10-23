/**
 * entityLocker.ts — Stage 007 §5 hard linguistic anti-merging constraints.
 *
 * Structured (headword, digit) pairs (road, sector, block, gate, house,
 * lane, avenue, street, holding) and bound cardinal directions are locked
 * IN ENCOUNTER ORDER into the cluster identity. Permuted entities never
 * merge: "road 11 sector 3" != "road 3 sector 11";
 * "gate 1 road 2" != "road 1 gate 2".
 *
 * Name-token order insensitivity lives ONLY in the phonetic key
 * (bengaliPhonetics.ts, user decision 2026-10-22) — never here. Digit/gate
 * locks and direction bindings are ordered, always.
 */

export interface StructuredEntity {
  headword: string;
  value: string;
}

export interface BoundDirection {
  anchor: string;
  direction: string;
}

/** Headwords that bind a following numeral into a locked entity (F-007-2). */
export const ENTITY_HEADWORDS: ReadonlySet<string> = new Set([
  'road', 'sector', 'block', 'gate', 'avenue', 'lane', 'street', 'house', 'holding',
]);

/** Bangla + Banglish + English cardinal tokens, folded to canonical English. */
export const DIRECTION_TOKENS_MAP: Record<string, string> = {
  'purbo': 'east', 'পূর্ব': 'east', 'east': 'east',
  'poshchim': 'west', 'পশ্চিম': 'west', 'west': 'west',
  'uttor': 'north', 'উত্তর': 'north', 'north': 'north',
  'dokkhin': 'south', 'দক্ষিণ': 'south', 'south': 'south',
};

/**
 * Extract ordered structured entities + ordered direction bindings from
 * expanded tokens. Directions bind to the adjacent anchor token
 * (left neighbor preferred).
 */
export function extractEntities(tokens: string[]): {
  structuredEntities: StructuredEntity[];
  boundDirections: BoundDirection[];
} {
  const structuredEntities: StructuredEntity[] = [];
  const boundDirections: BoundDirection[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (ENTITY_HEADWORDS.has(t) && next !== undefined && /^\d+$/.test(next)) {
      structuredEntities.push({ headword: t, value: next });
    }
    if (DIRECTION_TOKENS_MAP[t] !== undefined) {
      const anchor = tokens[i - 1] ?? tokens[i + 1] ?? '';
      boundDirections.push({ anchor, direction: DIRECTION_TOKENS_MAP[t] });
    }
  }
  return { structuredEntities, boundDirections };
}

/** Ordered encounter-order signature: the cluster-identity component. */
export function entitySignature(
  structuredEntities: StructuredEntity[],
  boundDirections: BoundDirection[],
): string {
  const entitySig = structuredEntities.map((e) => `${e.headword}:${e.value}`).join(',');
  const dirSig = boundDirections.map((d) => `${d.anchor}:${d.direction}`).join(',');
  return `${entitySig}|${dirSig}`;
}

/** True iff two queries share identical ordered entity/direction identity. */
export function sameEntityIdentity(
  a: { structuredEntities: StructuredEntity[]; boundDirections: BoundDirection[] },
  b: { structuredEntities: StructuredEntity[]; boundDirections: BoundDirection[] },
): boolean {
  return entitySignature(a.structuredEntities, a.boundDirections) ===
    entitySignature(b.structuredEntities, b.boundDirections);
}
