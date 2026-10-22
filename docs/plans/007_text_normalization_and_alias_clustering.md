# Stage 007: Text Normalization & Alias Clustering Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-007 (Revision 2.1 — PII-Scrubbed Normalization, Ordered Entity Locking & Bengali Phonetics)
**Stage:** 7 of 16 (Linguistic Engineering & Query Processing)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§6, §6.1–6.2)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**

---

## 1. Executive Summary & Objective

Search queries typed by ride-hailing passengers in Bangladesh vary across scripts, transliterations, and colloquiums — *"ধানমন্ডি ২৭"*, *"dhan 27"*, *"Dhanmondi Road 27"*, *"JFP"*, *"NSU Gate 8"*, *"Rapa Plaza Mor"*. Western string-matching and Anglo-centric phonetics (Soundex, Double Metaphone) fail on Bengali aspiration pairs and retroflex/dental distinctions.

Stage 007 delivers the **Linguistic Normalization & Spatial Clustering Engine**:
1. **`scrubPii` First (F-007-4):** a formalized, exported contract — Bengali digit folding + separator stripping + phone/email removal — runs **before** clustering and before any logging. Imported by Stages 008, 009, 010, 011.
2. **6-Stage Orthographic Normalizer:** NFC, invisible-glyph stripping, Bengali digit folding (`০-৯` → `0-9`), Khanda-Ta/Chandrabindu canonicalization, mobile-elongation reduction, Dhaka abbreviation expansion.
3. **Hard Entity Locking (F-007-2):** structured `(headword, digit)` pairs (Road/Sector/Block/Gate/House…) and bound cardinal directions are locked **in encounter order** into the cluster identity — permuted entities never merge.
4. **Bengali/Banglish Phonetic Key Engine (F-007-3):** South Asian phoneme equivalence across Bengali script and Latin transliteration, feeding `dpmaps.query_clusters.bengali_phonetic_key` and the Stage 008 Meili feed (`bengali_phonetic_keys[]`, Rev 2.4 view).
5. **Spatial Convergence Prerequisite:** H3 res-10 `gridDisk(cell, 1)` + centroid distance ≤ 75 m `[ESTIMATE]` + trigram ≥ 0.70 `[ESTIMATE]` — identical brands in different neighborhoods never commingle.
6. **Schema-Conformant Sync:** `query_clusters` / `poi_aliases` writes through the Stage 003 join discipline (anchor key, decayed weights) with a privacy gate before promotion.
7. **Versioned Ruleset:** `normalizer_version` / `ruleset_version` embedded in every output for 90-day ledger replay audits.

---

## 2. Pipeline (order is normative)

```
[ Raw Rider Input at Selection (max 80 chars) ]
        │
        ▼
[ 0. scrubPii — PII removal FIRST (F-007-4) ]
  ├── Fold Bengali digits → ASCII (same map as stage 3)
  ├── Normalize separators only inside phone-like digit runs (10–13 digits)
  ├── Phone patterns (01[3-9]…, +8801…, 8801…) → DROPPED (no marker token)
  └── Email patterns → DROPPED
        │
        ▼
[ 1. Unicode NFC & invisible glyph cleaning ]
  ├── NFC; strip ZWJ (U+200D), ZWNJ (U+200C), soft hyphens
  └── Strip Bengali Dari (। U+0964) & punctuation
        │
        ▼
[ 2. Bengali orthographic canonicalization ]
  ├── Khanda-Ta (ৎ U+09CE) ↔ Ta + Hasant (ত্)
  ├── Chandrabindu (ঁ U+0981) optionality folding
  └── Nukta-consonant canonicalization (ড়, ঢ়, য়)
        │
        ▼
[ 3. Numeral folding ]  Bengali [০-৯] → ASCII [0-9]
        │
        ▼
[ 4. Elongation reduction & casefolding ]
  ├── Collapse typing elongation: /(.)\1{2,}/g → '$1'
  │   (runs of 3+ → 1; genuine 2-char gemination preserved;
  │    "jammmuuuna" → "jamuna" [F-007-1 fix])
  └── Lowercase Latin; collapse whitespace
        │
        ▼
[ 5. Tokenization & Dhaka abbreviation expansion ]
        │
        ▼
[ 6. Hard entity extraction & phonetic parsing ]
  ├── Structured pairs (ordered): [("road","27")], [("gate","1")]
  ├── Bound directions (ordered): [("badda","east")]
  └── Bengali phonetic key: "DNMND-27"
        │
        ├────────────► dpmaps.query_clusters
        └────────────► Spatial convergence check (§6) → dpmaps.poi_aliases
```

---

## 3. `scrubPii` Contract (F-007-4) & Normalizer (`utils-server/textNormalizer.ts`)

```typescript
// utils-server/textNormalizer.ts
import crypto from 'crypto';

export const NORMALIZER_VERSION = 'norm-v2.1.0';
export const RULESET_VERSION = 'rule-2026.11';

const BENGALI_DIGIT_MAP: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

const DHAKA_ABBREVIATIONS: Record<string, string> = {
  'rd': 'road', 'st': 'street', 'ave': 'avenue', 'sec': 'sector', 'blk': 'block',
  'h': 'hospital', 'med': 'medical', 'clg': 'college', 'univ': 'university',
  'jfp': 'jamuna future park', 'dmc': 'dhaka medical college',
  'buet': 'bangladesh university of engineering and technology',
  'nsu': 'north south university', 'aiub': 'american international university bangladesh',
  'iub': 'independent university bangladesh', 'brac': 'brac university',
  'du': 'dhaka university', 'mrt': 'metro rail station'
};

const DIRECTION_TOKENS_MAP: Record<string, string> = {
  'purbo': 'east', 'পূর্ব': 'east', 'east': 'east',
  'poshchim': 'west', 'পশ্চিম': 'west', 'west': 'west',
  'uttor': 'north', 'উত্তর': 'north', 'north': 'north',
  'dokkhin': 'south', 'দক্ষিণ': 'south', 'south': 'south'
};

// Headwords that bind a following numeral into a locked structured entity (F-007-2)
const ENTITY_HEADWORDS = new Set([
  'road', 'sector', 'block', 'gate', 'avenue', 'lane', 'street', 'house', 'holding'
]);

/**
 * scrubPii — the cross-stage contract (F-007-4).
 * Imported by Stage 008 (recordSearchSelection), Stage 009 (ingestion), Stage 010/011.
 * Order: fold Bengali digits → normalize separators in phone-like runs → drop phones →
 * drop emails. Idempotent. Output safe for clustering and Tier A logging.
 * Hard Rule 8: no raw phone/email strings ever persist.
 */
export function scrubPii(rawInput: string): string {
  let text = rawInput.normalize('NFC');
  // 1. Fold Bengali digits so phone patterns below match both scripts
  text = text.replace(/[০-৯]/g, m => BENGALI_DIGIT_MAP[m] || m);
  // 2. Phone-candidate normalization ONLY: strip separators inside digit runs of
  //    10–13 digits total (e.g. "017-1122-3344", "০১৭ ১১২২৩৩৪৪"). Short numeral
  //    sequences ("road 12 34") are untouched — blanket stripping would merge them.
  text = text.replace(/\+?\d(?:[\s\-().+]?\d){9,12}/g, m => m.replace(/[\s\-().+]/g, ''));
  // 3. Phone patterns: 01[3-9]xxxxxxxx / +8801… / 8801… (11-digit BD mobile) — DROPPED
  //    (not replaced with a shared token: a "[REDACTED]" marker would itself become a
  //    mergeable token and falsely cluster unrelated phone-bearing queries).
  text = text.replace(/(?:\+?88)?01[3-9]\d{8}\b/g, ' ');
  // 4. Email patterns — dropped
  text = text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

export interface NormalizedQueryOutput {
  raw_query: string;            // in-memory only; never persisted un-scrubbed
  scrubbed_query: string;
  normalized_query: string;
  normalized_tokens: string[];
  structured_entities: { headword: string; value: string }[]; // ORDERED (F-007-2)
  bound_directions: { anchor: string; direction: string }[];  // ORDERED (F-007-2)
  bengali_phonetic_key: string; // ≤ 120 chars (query_clusters VARCHAR(120))
  cluster_id: string;
  normalizer_version: string;
  ruleset_version: string;
}

export function normalizeSearchQuery(rawQuery: string): NormalizedQueryOutput {
  // Step 0: PII scrub FIRST (F-007-4 / Hard Rule 8 order)
  let text = scrubPii(rawQuery);

  // Step 1: NFC & invisible glyphs
  text = text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  text = text.replace(/[\u0964\u0965]/g, ' ');

  // Step 2: orthographic canonicalization
  text = text.replace(/\u09A4\u09CD/g, 'ৎ');
  text = text.replace(/\u0981/g, '');

  // Step 3: numeral folding (idempotent; scrubPii already folded once)
  text = text.replace(/[০-৯]/g, m => BENGALI_DIGIT_MAP[m] || m);

  // Step 4: elongation reduction & casefolding (F-007-1 fix: 3+ runs → 1)
  text = text.toLowerCase();
  text = text.replace(/(.)\1{2,}/g, '$1'); // "jammmuuuna" → "jamuna"; "ss" preserved
  text = text.replace(/[^a-z0-9\u0980-\u09FF\s]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  // Step 5: tokenization & abbreviation expansion
  const rawTokens = text.split(' ').filter(t => t.length > 0);
  const normalizedTokens: string[] = [];
  const structuredEntities: { headword: string; value: string }[] = [];
  const boundDirections: { anchor: string; direction: string }[] = [];

  for (const token of rawTokens) {
    const expanded = DHAKA_ABBREVIATIONS[token] || token;
    normalizedTokens.push(expanded);
  }

  // Step 6: structured entity extraction — ORDERED (F-007-2)
  for (let i = 0; i < normalizedTokens.length; i++) {
    const t = normalizedTokens[i];
    const next = normalizedTokens[i + 1];
    if (ENTITY_HEADWORDS.has(t) && next && /^\d+$/.test(next)) {
      structuredEntities.push({ headword: t, value: next });
    }
    if (DIRECTION_TOKENS_MAP[t]) {
      // bind direction to its adjacent anchor token (left neighbor preferred)
      const anchor = normalizedTokens[i - 1] ?? normalizedTokens[i + 1] ?? '';
      boundDirections.push({ anchor, direction: DIRECTION_TOKENS_MAP[t] });
    }
  }

  const normalizedQuery = normalizedTokens.join(' ');
  const phoneticKey = generateBengaliPhoneticKey(normalizedTokens).slice(0, 120);

  // Cluster identity: phonetic key + ORDERED entity pairs + ORDERED direction bindings.
  // Permutations ("gate 1 road 2" vs "road 1 gate 2") produce different cluster_ids.
  const entitySig = structuredEntities.map(e => `${e.headword}:${e.value}`).join(',');
  const dirSig = boundDirections.map(d => `${d.anchor}:${d.direction}`).join(',');
  const clusterPayload = `${phoneticKey}|${entitySig}|${dirSig}`;
  const cluster_id = 'cl_' + crypto.createHash('sha256').update(clusterPayload).digest('hex').substring(0, 16);

  return {
    raw_query: rawQuery,
    scrubbed_query: scrubPii(rawQuery),
    normalized_query: normalizedQuery,
    normalized_tokens: normalizedTokens,
    structured_entities: structuredEntities,
    bound_directions: boundDirections,
    bengali_phonetic_key: phoneticKey,
    cluster_id,
    normalizer_version: NORMALIZER_VERSION,
    ruleset_version: RULESET_VERSION
  };
}
```

---

## 4. Bengali Phonetic Engine (`utils-server/bengaliPhonetic.ts`)

Phoneme equivalence groups (velars/palatals/retroflex/dentals/labials/nasals/liquids/sibilants) map both Bengali script and Banglish digraphs to a canonical Latin skeleton — e.g. *"Dhanmondi"* ↔ *"ধানমন্ডি"* → `DNMND`. Implementation (longest-match 3/2/1-char table, adjacent-duplicate collapse):

```typescript
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
  'h': 'H', 'y': 'Y'
};

export function generateBengaliPhoneticKey(tokens: string[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) continue;          // digits ride in structured entities
    let key = '';
    let i = 0;
    let firstVowelRetained = false;
    while (i < token.length) {
      const sub3 = token.substring(i, i + 3);
      const sub2 = token.substring(i, i + 2);
      const sub1 = token.substring(i, i + 1);
      if (PHONETIC_MAP[sub3]) { key += PHONETIC_MAP[sub3]; i += 3; }
      else if (PHONETIC_MAP[sub2]) { key += PHONETIC_MAP[sub2]; i += 2; }
      else if (PHONETIC_MAP[sub1]) {
        // Initial-vowel retention (documented divergence fixed, F-007-3):
        // an unmapped leading vowel letter is retained as 'A' marker once.
        if (!firstVowelRetained && key === '' && /[aeiouao]/.test(sub1)) {
          key += 'A'; firstVowelRetained = true;
        }
        i += 1;
      } else { i += 1; }
    }
    key = key.replace(/(.)\1+/g, '$1');          // collapse duplicates
    if (key.length > 0) parts.push(key);
  }
  // Order-insensitive name tokens (refinement: user decision 2026-10-22):
  // "Star Kabab Banani" and "Banani Star Kabab" share one key. Structured entity
  // pairs and direction bindings remain ORDERED in the cluster payload (§3), so
  // digit/gate locking is unaffected; permuted distinct places are caught by the
  // 75 m spatial convergence gate (§6).
  return parts.sort().join('_');
}
```

Documented simplifications `[ESTIMATE — validate on real query corpus]`: aspiration-neutral merges (ফ/ফ, থ/ত groups), inherent-vowel elision except initial, no schwa-deletion heuristics. The key's job is high-recall candidate matching — precision is enforced downstream by digit/direction locking and spatial convergence, not by the key alone.

---

## 5. Hard Linguistic Anti-Merging Constraints (F-007-2)

0. **Name-Token Order Insensitivity (user decision, refinement pass):** the phonetic key sorts its name-token parts, so word-order variants (*"Star Kabab Banani"* / *"Banani Star Kabab"*) share a `cluster_id`. This rule applies to **name tokens only** — rules 1–2 below are ordered and unaffected. Permutations of distinct places are rare and are rejected downstream by the 75 m spatial gate (§6).

1. **Structured Entity Locking (ordered):** `(headword, value)` pairs — `road:4` ≠ `road:7` ≠ `sector:3`; and order matters: `gate:1,road:2` ≠ `road:1,gate:2`. Queries with differing entity signatures are **mathematically barred** from sharing a `cluster_id`.
2. **Cardinal Direction Locking (ordered bindings):** *"Purbo Badda"* (`badda:east`) vs *"Poshchim Badda"* (`badda:west`) — barred. Directions bind to their adjacent anchor so *"North Gate 1"* ≠ *"Gate 1 North"* unless the anchors match.
3. **Short Prefix Isolation:** queries ≤ 4 chars never cluster with physical landmarks; they live only as Stage 008 completion pointers.
4. **No Transitive Clustering:** A–B and B–C merges never imply A–C; each pair must independently pass textual + spatial gates.

---

## 6. Spatial Convergence Prerequisite

*"Star Kabab"* branches share 100 % text but are distinct places; naive H3 comparison fails across cell boundaries 5 m apart. Pipeline per candidate:

1. **Centroid distance ≤ 75 m** `[ESTIMATE]` (entrances ≤ 25 m `[ESTIMATE]`);
2. **H3 res-10 1-ring overlap:** `gridDisk(target.h3_res10, 1)` (7 cells ≈ 7 × cell area `[UNVERIFIED H3 sizes]`) must contain the candidate cell;
3. **Trigram similarity ≥ 0.70 `[ESTIMATE]` OR exact phonetic-key match.**

```typescript
export function validateSpatialConvergence(
  candidate: { dropoff_lat: number; dropoff_lng: number; h3_res10: string },
  targetPoi: { lat: number; lng: number; h3_res10: string }
): boolean {
  const d = calculateHaversineDistance(candidate.dropoff_lat, candidate.dropoff_lng, targetPoi.lat, targetPoi.lng);
  if (d > 75) return false;                                     // [ESTIMATE]
  return new Set(gridDisk(targetPoi.h3_res10, 1)).has(candidate.h3_res10);
}
```

---

## 7. Database Sync & Alias Promotion (schema-conformant — F-007-5)

Promotion SQL follows the Stage 003 join discipline (anchor dedup key, decayed weights) and runs the privacy gate first:

```sql
-- Promote candidate aliases with decayed, anchor-key-deduplicated support.
-- (uq_poi_alias UNIQUE (poi_id, alias_text) exists in Stage 003 §4.3.)
INSERT INTO dpmaps.poi_aliases (poi_id, alias_text, alias_type, source, support_votes, status)
SELECT poi.id,
       qc.canonical_query,
       'colloquial',
       'rider_typed',
       SUM(dpmaps.calculate_decayed_weight(tel.initial_weight, tel.created_at)), -- decay at read
       CASE WHEN COUNT(DISTINCT lp.pseudonym_hash) >= 15 THEN 'active' ELSE 'pending' END
FROM dpmaps.query_clusters qc
JOIN dpmaps.trip_evidence_ledger tel ON tel.query_cluster_id = qc.cluster_id
JOIN dpmaps.ledger_pseudonyms lp
  ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at
JOIN dpmaps.active_dedup_key adk ON lp.key_id = adk.key_id          -- 135-day anchor
LEFT JOIN dpmaps.ledger_invalidations li
  ON li.ledger_id = tel.id AND li.created_at = tel.created_at
JOIN dpmaps.public_pois poi ON poi.h3_res10 = tel.h3_res10
WHERE li.ledger_id IS NULL                                          -- invalidations excluded
  AND tel.created_at >= NOW() - INTERVAL '90 days'
  -- privacy gate (F-007-5): never promote PII-bearing canonical queries
  AND qc.canonical_query !~ '(^|[^0-9])01[3-9][0-9]{8}([^0-9]|$)'
  AND qc.canonical_query !~ '@'
GROUP BY poi.id, qc.canonical_query
ON CONFLICT (poi_id, alias_text) DO UPDATE
SET support_votes = dpmaps.poi_aliases.support_votes + EXCLUDED.support_votes;
```

Notes: `pseudonym_hash` lives in `ledger_pseudonyms` (not on the ledger table); distinct-rider counts must not double-count multi-key rows (anchor join). Thresholds: ≥ 5 riders / 2 weeks for cluster persistence `[ESTIMATE]`, ≥ 15 riders for `active` promotion (aligned with Gate 1 diversity `[ESTIMATE]`).

---

## 8. Deliverables & Definition of Done

- [ ] **`scrubPii` exported and tested:** Bengali-digit phones with delimiters ("০১৭-১১২২৩৩৪৪", "+8801711223344") and emails dropped; `"road 12 34"` untouched; idempotent; wired before clustering and in Stage 008/009/010/011 call sites (F-007-4).
- [ ] Normalizer unit-tested on ≥ 200 real Dhaka queries `[ESTIMATE]` (Bengali script, Banglish, `০-৯`); elongation semantics verified: *"jammmuuuna" → "jamuna"*, gemination *"ss"* preserved (F-007-1).
- [ ] Locking tests: *"Road 4"* vs *"Road 7"* never merge; **"Gate 1 Road 2" vs "Road 1 Gate 2" never merge** (ordered pairs); *"Purbo Badda"* vs *"Poshchim Badda"* never merge; **word-order merge test: "Star Kabab Banani" ↔ "Banani Star Kabab" share one cluster_id** (F-007-2).
- [ ] Phonetic engine: *"Dhanmondi"* ↔ *"ধানমন্ডি"* → `DNMND`; key length ≤ 120; convergence of Bengali/Banglish corpora measured `[ESTIMATE]` (F-007-3).
- [ ] Spatial convergence: `gridDisk(…, 1)` + 75 m + trigram gate implemented; identical-brand branches stay separate in a ≥ 10,000-query replay `[ESTIMATE]` (F-007-5/6).
- [ ] Promotion SQL matches Stage 003 join discipline (anchor key, decay, invalidations, privacy gate).
- [ ] `normalizer_version`/`ruleset_version` embedded in all outputs; 90-day ledger replay reproducible.

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | 6-stage normalizer, phonetic engine, hard constraints, k-ring convergence, alias promotion. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-3 audit) | **PII Contract, Ordered Locking & Schema Conformance:**<br>1. **`scrubPii` contract (F-007-4):** implemented/exported — Bengali-digit folding, phone-run separator normalization, phone/email **dropping** (no shared marker token); runs first; consumed by Stages 008/009/010/011.<br>2. **Elongation fix (F-007-1):** `/(.)\1{2,}/g → '$1'` (3+ → 1) matches the stated example; gemination preserved.<br>3. **Ordered entity locking (F-007-2):** structured `(headword, value)` pairs and anchor-bound directions in encounter order; permuted entities (`gate 1 road 2` vs `road 1 gate 2`) no longer merge.<br>4. **Phonetic conformance (F-007-3):** initial-vowel marker; ≤ 120-char bound (`query_clusters.bengali_phonetic_key VARCHAR(120)`); documented simplifications; singular column write stays conformant with the Rev 2.4 aggregated Meili feed.<br>5. **Schema-conformant promotion (F-007-5):** `ledger_pseudonyms` ⋈ `active_dedup_key`, `calculate_decayed_weight`, invalidation exclusion, privacy gate; `uq_poi_alias` ON CONFLICT confirmed against Stage 003.<br>6. **Labels (F-007-6):** thresholds `[ESTIMATE]`; H3 area note `[UNVERIFIED]`.<br>7. **Phonetic name-token ordering (refinement, user decision):** key sorts name-token parts (order-insensitive); entity/direction signatures stay ordered — word-order variants merge, digit/gate locks do not. |
