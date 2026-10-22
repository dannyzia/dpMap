# Stage 007: Text Normalization & Alias Clustering Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-007 (Revision 2.0 — Linguistic Engineering & Query Normalization)  
**Stage:** 7 of 16 (Linguistic Engineering & Query Processing)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§6, §6.1–6.2)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

Search queries typed by ride-hailing passengers in Bangladesh exhibit extraordinary linguistic variability. A single real-world destination is entered across multiple orthogonal scripts, transliterations, and colloquiums:
- **Classical Bengali Script:** *"ধানমন্ডি ২৭"*, *"যমুনা ফিউচার পার্ক"*
- **Phonetic Banglish:** *"dhan 27"*, *"danmondi shattaish"*, *"jomuna future park"*
- **Formal English:** *"Dhanmondi Road 27"*, *"Jamuna Future Park"*
- **Colloquial Acronyms & Abbreviations:** *"JFP"*, *"NSU Gate 8"*, *"DMC Emergency"*
- **Informal Nicknames & Historical Signposts:** *"Old 27"*, *"Sobhanbagh Masjid Mor"*, *"Rapa Plaza Mor"*

Standard Western string-matching algorithms (Levenshtein, Jaro-Winkler) and Anglo-centric phonetic algorithms (Soundex, Double Metaphone) fail catastrophically in Bangladesh. They misclassify Bengali aspiration pairs, confuse retroflex vs. dental consonants, and frequently merge distinct locations across town.

Stage 007 delivers an end-to-end **Linguistic Normalization & Spatial Clustering Engine**:
1. **The 6-Stage Orthographic Normalizer:** Standardizes Unicode NFC, strips invisible formatting glyphs (ZWJ/ZWNJ), folds Bengali numerals (`০-৯` $\rightarrow$ `0-9`), canonicalizes Khanda-Ta and Chandrabindu, reduces mobile typing elongation, and expands standard Dhaka abbreviations.
2. **Hard Linguistic Constraints:** Enforces absolute digit locking and cardinal direction preservation (*"Purbo"* vs. *"Poshchim"*), mathematically preventing dangerous false merges.
3. **Deterministic Bengali/Banglish Phonetic Key Engine:** Implements a South Asian phonetic parser that maps phoneme equivalence across Bengali script and Latin transliteration.
4. **Spatial Convergence Prerequisite (H3 $k$-ring):** Solves the H3 cell boundary problem using 1-ring neighborhood expansion and centroid distance verification ($\le 75\text{m}$), preventing identically named venues in different neighborhoods (*"Star Kabab Dhanmondi"* vs. *"Star Kabab Banani"*) from commingling.
5. **Database Integration & Alias Promotion:** Feeds clean records into `dpmaps.query_clusters` and promotes candidate aliases into `dpmaps.poi_aliases` (Stage 003) under verifiable distinct-rider thresholds.
6. **Versioned Ruleset Management:** Embeds `normalizer_version` (`norm-v2.0.0`) and `ruleset_version` into all output clusters, enabling full clean-room replay audits over the 90-day evidence ledger.

---

## 2. The Normalization & Clustering Pipeline Architecture

```
[ Raw Rider Input at Selection Moment (Max 80 Chars) ]
                           │
                           ▼
[ 1. Unicode NFC & Invisible Glyph Cleaning ]
  ├── Unicode NFC normalization
  ├── Strip ZWJ (U+200D), ZWNJ (U+200C), and soft hyphens
  └── Strip Bengali Dari (। U+0964) and punctuation
                           │
                           ▼
[ 2. Bengali Orthographic Canonicalization ]
  ├── Khanda-Ta (ৎ U+09CE) <-> Ta + Hasant (ত্) canonicalization
  ├── Chandrabindu (ঁ U+0981) optionality folding
  └── Nukta-consonant canonicalization (ড়, ঢ়, য়)
                           │
                           ▼
[ 3. Numeral & Digit Folding ]
  └── Bengali Numerals [০-৯] -> Standard ASCII [0-9]
                           │
                           ▼
[ 4. Elongation Reduction & Casefolding ]
  ├── Collapse runs of 3+ identical characters: /(.)\1{2,}/g -> $1$1
  └── Lowercase all Latin characters; collapse whitespace
                           │
                           ▼
[ 5. Tokenization & Dhaka Abbreviation Expansion ]
  ├── Expand "rd" -> "road", "sec" -> "sector", "blk" -> "block"
  └── Expand transit landmarks: "jfp", "buet", "dmc", "nsu", "aiub"
                           │
                           ▼
[ 6. Hard Entity Extraction & Phonetic Parsing ]
  ├── Extract Hard Digits Set: {"27"}
  ├── Extract Hard Directions Set: {"purbo"}
  └── Compute Bengali Phonetic Key: "DNMND-27"
                           │
                           ▼
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
[ dpmaps.query_clusters ]          [ Spatial Convergence Check ]
• cluster_id                       • H3 res 10 1-ring overlap
• canonical_query                  • Centroid distance <= 75m
• normalized_tokens                • Trigram similarity >= 0.70
• bengali_phonetic_key                        │
                                              ▼
                                   [ dpmaps.poi_aliases ]
                                   (Promoted Candidate Aliases)
```

---

## 3. Detailed Text Normalizer Implementation

The normalization module (`utils-server/textNormalizer.ts`) processes all incoming search strings:

```typescript
// utils-server/textNormalizer.ts
import crypto from 'crypto';

export const NORMALIZER_VERSION = 'norm-v2.0.0';
export const RULESET_VERSION = 'rule-2026.11';

const BENGALI_DIGIT_MAP: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

const DHAKA_ABBREVIATIONS: Record<string, string> = {
  'rd': 'road',
  'st': 'street',
  'ave': 'avenue',
  'sec': 'sector',
  'blk': 'block',
  'h': 'hospital',
  'med': 'medical',
  'clg': 'college',
  'univ': 'university',
  'jfp': 'jamuna future park',
  'dmc': 'dhaka medical college',
  'buet': 'bangladesh university of engineering and technology',
  'nsu': 'north south university',
  'aiub': 'american international university bangladesh',
  'iub': 'independent university bangladesh',
  'brac': 'brac university',
  'du': 'dhaka university',
  'mrt': 'metro rail station'
};

const DIRECTION_TOKENS_MAP: Record<string, string> = {
  'purbo': 'east', 'পূর্ব': 'east', 'east': 'east',
  'poshchim': 'west', 'পশ্চিম': 'west', 'west': 'west',
  'uttor': 'north', 'উত্তর': 'north', 'north': 'north',
  'dokkhin': 'south', 'দক্ষিণ': 'south', 'south': 'south'
};

export interface NormalizedQueryOutput {
  raw_query: string;
  normalized_query: string;
  normalized_tokens: string[];
  digits: string[];
  canonical_directions: string[];
  bengali_phonetic_key: string;
  cluster_id: string;
  normalizer_version: string;
  ruleset_version: string;
}

export function normalizeSearchQuery(rawQuery: string): NormalizedQueryOutput {
  // Step 1: Unicode NFC Normalization & Strip Invisible Glyphs
  let text = rawQuery.normalize('NFC');
  text = text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ''); // Strip ZWJ, ZWNJ, Soft Hyphen
  text = text.replace(/[\u0964\u0965]/g, ' ');            // Replace Bengali Dari with space

  // Step 2: Bengali Orthographic Canonicalization
  text = text.replace(/\u09A4\u09CD/g, 'ৎ');                // ত্ -> ৎ (Khanda-Ta)
  text = text.replace(/\u0981/g, '');                       // Fold Chandrabindu (ঁ)

  // Step 3: Numeral Folding (Bengali -> ASCII)
  text = text.replace(/[০-৯]/g, match => BENGALI_DIGIT_MAP[match] || match);

  // Step 4: Elongation Reduction & Lowercasing
  text = text.toLowerCase();
  text = text.replace(/(.)\1{2,}/g, '$1$1');                // "jammmuuuna" -> "jamuna"
  text = text.replace(/[^a-z0-9\u0980-\u09FF\s]/g, ' ');   // Keep alphanumeric & Bengali script
  text = text.replace(/\s+/g, ' ').trim();

  // Step 5: Tokenization & Abbreviation Expansion
  const rawTokens = text.split(' ').filter(t => t.length > 0);
  const normalizedTokens: string[] = [];
  const digits: string[] = [];
  const directions: Set<string> = new Set();

  for (const token of rawTokens) {
    // Extract embedded numbers
    const foundDigits = token.match(/\d+/g);
    if (foundDigits) {
      digits.push(...foundDigits);
    }

    // Extract standardized cardinal directions
    if (DIRECTION_TOKENS_MAP[token]) {
      directions.add(DIRECTION_TOKENS_MAP[token]);
    }

    // Expand known abbreviations
    const expanded = DHAKA_ABBREVIATIONS[token] || token;
    normalizedTokens.push(expanded);
  }

  const normalizedQuery = normalizedTokens.join(' ');
  const sortedDigits = Array.from(new Set(digits)).sort((a, b) => Number(a) - Number(b));
  const sortedDirections = Array.from(directions).sort();

  // Step 6: Generate Bengali Phonetic Sound Key
  const phoneticKey = generateBengaliPhoneticKey(normalizedTokens, sortedDigits);

  // Step 7: Deterministic Cluster Identifier
  const clusterPayload = `${phoneticKey}|${sortedDigits.join(',')}|${sortedDirections.join(',')}`;
  const cluster_id = 'cl_' + crypto.createHash('sha256').update(clusterPayload).digest('hex').substring(0, 16);

  return {
    raw_query: rawQuery,
    normalized_query: normalizedQuery,
    normalized_tokens: normalizedTokens,
    digits: sortedDigits,
    canonical_directions: sortedDirections,
    bengali_phonetic_key: phoneticKey,
    cluster_id,
    normalizer_version: NORMALIZER_VERSION,
    ruleset_version: RULESET_VERSION
  };
}
```

---

## 4. Deterministic South Asian Phonetic Engine (`bengaliPhonetic.ts`)

Anglo-centric algorithms (Metaphone) fail on Bengali transliterations because English letter patterns do not reflect Indo-Aryan phonetic relationships. Stage 007 implements a specialized **Bengali Phonetic Algorithm**:

```
[ Input Tokens ]
       │
       ▼
[ Consonant Group Equivalence Mapping ]
├── Velars:      [ক, খ, k, kh, q, c (hard)] -> K   │  [গ, ঘ, g, gh] -> G
├── Palatals:    [চ, ছ, ch, chh] -> C             │  [জ, ঝ, য, j, jh, z] -> J
├── Retroflex:   [ট, ঠ, t, th (hard)] -> T        │  [ড, ঢ, d, dh (hard)] -> D
├── Dentals:     [ত, থ, t, th (soft)] -> T        │  [দ, ধ, d, dh (soft)] -> D
├── Labials:     [প, ফ, p, ph, f] -> P            │  [ব, ভ, b, bh, v, w] -> B
├── Nasals:      [ম, m] -> M                      │  [ন, ণ, ং, n, ng] -> N
├── Liquids:     [র, ড়, ঢ়, r, rh] -> R            │  [ল, l] -> L
└── Sibilants:   [শ, ষ, স, s, sh] -> S            │  [হ, h] -> H
       │
       ▼
[ Discard Inherent Vowels Except Initial & Retain Digits Verbatim ]
       │
       ▼
[ Output Key: e.g., "DNMND-27" ]
```

```typescript
// utils-server/bengaliPhonetic.ts

const PHONETIC_MAP: Record<string, string> = {
  // Bengali Script Mapping
  'ক': 'K', 'খ': 'K', 'গ': 'G', 'ঘ': 'G', 'ঙ': 'N',
  'চ': 'C', 'ছ': 'C', 'জ': 'J', 'ঝ': 'J', 'ঞ': 'N',
  'ট': 'T', 'ঠ': 'T', 'ড': 'D', 'ঢ': 'D', 'ণ': 'N',
  'ত': 'T', 'থ': 'T', 'দ': 'D', 'ধ': 'D', 'ন': 'N',
  'প': 'P', 'ফ': 'P', 'ব': 'B', 'ভ': 'B', 'ম': 'M',
  'য': 'J', 'র': 'R', 'ল': 'L', 'শ': 'S', 'ষ': 'S',
  'স': 'S', 'হ': 'H', 'ড়': 'R', 'ঢ়': 'R', 'য়': 'Y',
  'ৎ': 'T', 'ং': 'N', 'ঃ': 'H',

  // Banglish / Latin Transliteration Mapping
  'kh': 'K', 'gh': 'G', 'ch': 'C', 'chh': 'C', 'jh': 'J',
  'th': 'T', 'dh': 'D', 'ph': 'P', 'bh': 'B', 'sh': 'S',
  'k': 'K', 'c': 'K', 'q': 'K', 'g': 'G', 'j': 'J', 'z': 'J',
  't': 'T', 'd': 'D', 'p': 'P', 'f': 'P', 'b': 'B', 'v': 'B',
  'w': 'B', 'm': 'M', 'n': 'N', 'r': 'R', 'l': 'L', 's': 'S',
  'h': 'H', 'y': 'Y'
};

export function generateBengaliPhoneticKey(tokens: string[], digits: string[]): string {
  const phoneticParts: string[] = [];

  for (const token of tokens) {
    if (/^\d+$/.test(token)) continue; // Handled separately in digit set

    let key = '';
    let i = 0;
    while (i < token.length) {
      // Check 3-char, 2-char, then 1-char combinations
      const sub3 = token.substring(i, i + 3);
      const sub2 = token.substring(i, i + 2);
      const sub1 = token.substring(i, i + 1);

      if (PHONETIC_MAP[sub3]) {
        key += PHONETIC_MAP[sub3];
        i += 3;
      } else if (PHONETIC_MAP[sub2]) {
        key += PHONETIC_MAP[sub2];
        i += 2;
      } else if (PHONETIC_MAP[sub1]) {
        key += PHONETIC_MAP[sub1];
        i += 1;
      } else {
        i += 1;
      }
    }

    // Collapse adjacent duplicate phonetic characters (e.g. "KK" -> "K")
    key = key.replace(/(.)\1+/g, '$1');
    if (key.length > 0) phoneticParts.push(key);
  }

  const basePhonetic = phoneticParts.join('_');
  return digits.length > 0 ? `${basePhonetic}-${digits.join('_')}` : basePhonetic;
}
```

---

## 5. Hard Linguistic Anti-Merging Constraints

To eliminate catastrophic false merges in automated map learning, the engine enforces four **non-negotiable hard rules**:

1. **Strict Digit Locking Rule:**
   Queries containing differing numeric components are **mathematically barred from merging**, regardless of 100% phonetic or spatial overlap:
   - *"Road 4"* vs. *"Road 7"* $\rightarrow$ **STRICTLY BLOCKED**
   - *"Uttara Sector 3"* vs. *"Uttara Sector 11"* $\rightarrow$ **STRICTLY BLOCKED**
   - *"Dhanmondi 27"* vs. *"Dhanmondi 32"* $\rightarrow$ **STRICTLY BLOCKED**
2. **Cardinal Direction Locking Rule:**
   Queries with conflicting directional signifiers are barred from merging:
   - *"Purbo Badda"* (East Badda) vs. *"Poshchim Badda"* (West Badda) $\rightarrow$ **BLOCKED**
   - *"Dokkhin Khan"* (South Khan) vs. *"Uttor Khan"* (North Khan) $\rightarrow$ **BLOCKED**
3. **Short Prefix Isolation:**
   Queries $\le 4$ characters (e.g., *"dha"*, *"mir"*, *"gul"*, *" ধান"*) are never clustered with physical landmarks. They exist solely in the Stage 008 MeiliSearch in-memory prefix trie as completion pointers.
4. **No Transitive Clustering:**
   If Query $A$ merges with Query $B$, and Query $B$ merges with Query $C$, Query $A$ is **not** clustered with $C$ unless direct textual and spatial overlap between $A$ and $C$ satisfies all promotion criteria independently.

---

## 6. Spatial Convergence Prerequisite (Solving the H3 Boundary Problem)

Text similarity alone is dangerous: *"Star Kabab"* in Dhanmondi, *"Star Kabab"* in Banani, and *"Star Kabab"* in Karwan Bazar have 100% text identity but represent distinct physical destinations.

Furthermore, naive H3 discrete cell comparison fails when two drop-offs occur 5 meters apart across a cell boundary. Stage 007 implements **H3 $k$-Ring Neighborhood Expansion & Centroid Distance Verification**:

```
[ Candidate Query Dropoffs ]            [ Target POI Anchor ]
         │                                       │
         ▼                                       ▼
[ Spatial Centroid A ]                  [ Spatial Centroid B ]
         │                                       │
         └───────────────────┬───────────────────┘
                             │
                             ▼
              [ 1. Centroid Distance Check ]
              • Haversine Distance <= 75 meters?
                             │ (YES)
                             ▼
              [ 2. H3 k-Ring Overlap Check ]
              • Expand H3 res 10 cell of POI using gridDisk(cell, 1) (7 neighboring cells)
              • Query drop-off cell MUST reside inside the 1-ring neighborhood!
                             │ (YES)
                             ▼
              [ 3. Trigram Text Similarity Check ]
              • Trigram similarity >= 0.70 OR Exact Phonetic Key Match
```

```typescript
// workers/aliasClusteringWorker.ts
import { gridDisk, latLngToCell } from 'h3-js';
import { calculateHaversineDistance } from '../utils-server/geoMath';
import { NormalizedQueryOutput } from '../utils-server/textNormalizer';

export interface SpatialCandidate {
  query: NormalizedQueryOutput;
  dropoff_lat: number;
  dropoff_lng: number;
  h3_res10: string;
}

export function validateSpatialConvergence(
  candidate: SpatialCandidate,
  targetPoi: { id: string; lat: number; lng: number; h3_res10: string; canonical_name: string }
): boolean {
  // 1. Hard Centroid Distance Check (Max 75m for POIs, 25m for Entrances)
  const distanceMeters = calculateHaversineDistance(
    candidate.dropoff_lat,
    candidate.dropoff_lng,
    targetPoi.lat,
    targetPoi.lng
  );
  if (distanceMeters > 75) {
    return false; // Physically separate venue (e.g. branch in another neighborhood)
  }

  // 2. H3 Res 10 1-Ring Adjacency Check (Overcoming Cell Boundary Glitches)
  // gridDisk(cell, 1) returns the central cell plus its 6 immediate neighbors (~105,000 m²)
  const neighboringCells = new Set(gridDisk(targetPoi.h3_res10, 1));
  if (!neighboringCells.has(candidate.h3_res10)) {
    return false;
  }

  return true;
}
```

---

## 7. Database Synchronization & Alias Promotion Workflow

When candidate aliases satisfy textual, phonetic, and spatial gates, they are integrated into Stage 003 PostGIS schemas:

```
[ 90-Day Evidence Ledger (trip_evidence_ledger) ]
                         │
                         ▼ (Nightly Clustering Worker: 22:00 UTC)
[ Group by query_cluster_id & h3_res10 ]
  ├── Filter: Distinct riders >= 5 across >= 2 distinct calendar weeks
  ├── Validate: Anti-merging hard constraints (digits & directions)
  └── Check: Clean-room filter (strip PII, phone numbers, vendor patterns)
                         │
                         ▼
[ Insert / Update dpmaps.query_clusters ]
  INSERT INTO dpmaps.query_clusters 
    (cluster_id, canonical_query, normalized_tokens, bengali_phonetic_key, alias_count)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (cluster_id) DO UPDATE SET alias_count = query_clusters.alias_count + 1;
                         │
                         ▼
[ Promote to dpmaps.poi_aliases ]
  ├── If Distinct Riders >= 15 AND Confidence >= 0.95 -> status = 'active'
  └── Else -> status = 'pending' (Awaiting surveyor / editorial review)
```

```sql
-- Automated Alias Promotion Query
INSERT INTO dpmaps.poi_aliases (
  poi_id,
  alias_text,
  alias_type,
  source,
  support_votes,
  status
)
SELECT 
  poi.id AS poi_id,
  qc.canonical_query AS alias_text,
  'colloquial' AS alias_type,
  'rider_typed' AS source,
  SUM(tel.initial_weight) AS support_votes,
  'active' AS status
FROM dpmaps.query_clusters qc
JOIN dpmaps.trip_evidence_ledger tel ON tel.query_cluster_id = qc.cluster_id
JOIN dpmaps.public_pois poi ON poi.h3_res10 = tel.h3_res10
WHERE tel.created_at >= NOW() - INTERVAL '90 days'
GROUP BY poi.id, qc.canonical_query
HAVING COUNT(DISTINCT tel.pseudonym_hash) >= 15
ON CONFLICT (poi_id, alias_text) DO UPDATE 
SET support_votes = EXCLUDED.support_votes,
    status = 'active';
```

---

## 8. Deliverables & Definition of Done

- [ ] `utils-server/textNormalizer.ts` implemented and unit tested against 200 real Dhaka sample queries (covering Bengali script, Banglish, and numerals `০-৯`).
- [ ] Bengali orthographic canonicalization verified: ZWJ/ZWNJ stripped, Khanda-Ta canonicalized, and elongated vowels collapsed (`/(.)\1{2,}/g`).
- [ ] South Asian phonetic engine (`bengaliPhonetic.ts`) operational: generates unified phonetic keys across Bengali script and English transliterations (e.g. *"Dhanmondi"* $\leftrightarrow$ *"ধানমন্ডি"* $\rightarrow$ `DNMND`).
- [ ] Hard anti-merging constraints verified: test suite asserts that *"Road 4"* vs. *"Road 7"* and *"Purbo"* vs. *"Poshchim"* fail to merge with 100% certainty.
- [ ] H3 $k$-ring (`gridDisk(cell, 1)`) and 75-meter spatial distance validation implemented in `aliasClusteringWorker.ts`.
- [ ] Automated database synchronization active: populates `dpmaps.query_clusters` and promotes high-confidence candidate aliases ($\ge 15$ riders) to `dpmaps.poi_aliases`.
- [ ] Replay test on 10,000 historical test queries demonstrates zero false merges across separate branches of identical venue brands (e.g. Star Kabab branches).
- [ ] Versioning tags `normalizer_version: norm-v2.0.0` and `ruleset_version: rule-2026.11` embedded in all outputs for clean-room audit compliance.
