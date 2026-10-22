# Stage 010: Naming Engine & Post-Trip Verification Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-010  
**Stage:** 10 of 16 (Presentation Layer & Organic Verification)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§4, §9, §9.1–9.2)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 2 (The Routing Switch Flip / Presentation Autonomy)  
**Primary Dependencies:** [`001_phase0_landmark_seeding_and_data_assets.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/001_phase0_landmark_seeding_and_data_assets.md), [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`007_text_normalization_and_alias_clustering.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/007_text_normalization_and_alias_clustering.md), [`009_winner_selection_and_statistical_confidence.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/009_winner_selection_and_statistical_confidence.md)

---

## 1. Executive Summary & Objective

Layer 3 of the learning engine governs how physical locations are formatted, verified, and presented to passengers across the mobile application, client autocomplete list, and map canvas. Naive map systems frequently suffer from "raw text pollution," publishing informal user keystrokes (e.g., *"dhan 27 gate er samne"*, *"mama arong er kache"*), exposing residential flat numbers, personal phone numbers, or vulgarities.

Stage 010 establishes a sovereign, culturally attuned **Presentation Layer & Verification Engine**:
1. **The 4-Tier Display Name Authority Hierarchy:** Strictly dictates which source possesses the authority to name a physical map entity.
2. **Decoupled Identity and Relational Aliases:** Fully aligns with Stage 003's schema. Primary entity names (`canonical_name`, `bangla_name`) are stored in `dpmaps.public_pois`, while colloquial, transliterated, and search variants are tracked in `dpmaps.poi_aliases`.
3. **Bilingual Dual-Name Standard & Civic Transliteration Engine:** Guarantees that every published entity carries an official English Latin name and a culturally correct Bengali script name, supported by a curated bidirectional civic dictionary and phonetic transliteration.
4. **Organic Post-Trip Verification Prompt:** A clean-room, strictly non-incentivized feedback mechanism presented on destination arrival (<10% sampling) to organically name unindexed spatial clusters without exposing the platform to Sybil farming.
5. **Multi-Stage Sanitizer & PII Firewall:** Filters residential flat/house numbers, phone numbers, and local profanities, while stripping conversational clutter (*"er samne"*, *"opposite to"*).

---

## 2. The 4-Tier Display Name Authority Hierarchy

Presentation names are determined through a strict four-tier authority hierarchy. A lower tier can **never** override a higher tier:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        4-TIER DISPLAY NAME AUTHORITY HIERARCHY                         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Tier 1: Survey & Merchant Onboarding ] (Highest Trust - Authoritative Ground Truth)  │
│ • Sourced from clean-room field surveys (Landmark Pin Tool) & verified merchants.      │
│ • Backed by signed Clean-Room Contributor Agreements and merchant trade licenses.      │
│ • Overrides all crowdsourced strings. Published immediately upon surveyor validation.  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│       │ (If unmapped in Tier 1, evaluate Tier 2)                                       │
│       ▼                                                                                │
│ [ Tier 2: Post-Trip Verification Prompt ] (Crowdsourced Organic Consensus)             │
│ • High-confidence passenger submissions via post-trip feedback on destination arrival. │
│ • Quorum: >= 5 distinct riders per cycle; Consensus: >= 60% agreement on normalized   │
│   name string. Secondary candidates (>= 20%) promoted to poi_aliases.                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│       │ (If unmapped in Tier 2, evaluate Tier 3)                                       │
│       ▼                                                                                │
│ [ Tier 3: Formatted Canonical Query ] (Algorithmic Transformation)                     │
│ • Canonical formatted version of the leading normalized rider query from Stage 009.    │
│ • Automated title casing, abbreviation expansion, and conversational suffix stripping. │
│ • Must clear multi-stage PII, residential structure, and profanity filters.            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│       │ (If ambiguous or below threshold, evaluate Tier 4)                             │
│       ▼                                                                                │
│ [ Tier 4: Ephemeral Vendor Passthrough / Coarse Centroid ] (Ephemeral Fallback)        │
│ • Vendor suggestion text displayed strictly in client UI during trip dispatch.         │
│ • ABSOLUTE INVARIANT: Vendor text is NEVER written to public_pois, NEVER written to    │
│   poi_aliases, NEVER stored in trip history receipts, and NEVER indexed in MeiliSearch.│
│ • If vendor disabled: Fall back to administrative neighborhood centroid (e.g., ADM4). │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 The Non-Negotiable Invariants of Layer 3
1. **Separation of Physics and Naming:** Passenger trip drop-offs prove that a physical destination exists (Layer 2 Identity); they **never** independently decide how that destination is named.
2. **Zero Raw User Keystrokes:** Raw, unformatted search queries are never rendered on the map or in autocomplete. Every string must pass the Stage 010 formatter.
3. **No Vendor Text Retention (Clean-Room Firewall):** Vendor-supplied destination strings are ephemeral client display tokens. Storing vendor strings into the database or using them as training labels is an explicit violation of the Stage 002 Clean-Room Legal Firewall.

---

## 3. Bilingual Dual-Names Standard & Relational Schema Integration

In Bangladesh, urban navigation requires bilingual parity. An English-only map alienates local passengers and drivers, while a Bengali-only map impedes corporate users and international visitors.

### 3.1 Entity Representation in `dpmaps.public_pois`
Every landmark in `dpmaps.public_pois` enforces bilingual presence via database constraints:

```sql
-- Schema alignment with Stage 003
ALTER TABLE dpmaps.public_pois
  ADD CONSTRAINT chk_poi_name_exists 
  CHECK (canonical_name IS NOT NULL OR bangla_name IS NOT NULL);
```

- `canonical_name VARCHAR(255)`: Standardized English Latin title-cased name (*"Square Hospital"*).
- `bangla_name VARCHAR(255)`: Culturally correct Bengali script representation (*"স্কয়ার হাসপাতাল"*).
- `point_type dpmaps.point_type_enum NOT NULL`: Explicit physical taxonomy (`building`, `entrance`, `dropoff_point`, `area`).

### 3.2 Relational Aliases in `dpmaps.poi_aliases`
Search variants, colloquial nicknames, and historical misspellings are decoupled into `dpmaps.poi_aliases` (Stage 003 schema):

```sql
-- Search alias relational table
CREATE TABLE dpmaps.poi_aliases (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  alias_text VARCHAR(255) NOT NULL,
  alias_type VARCHAR(32) NOT NULL CHECK (alias_type IN ('transliteration', 'colloquial', 'acronym', 'misspelling')),
  source VARCHAR(32) NOT NULL CHECK (source IN ('surveyor', 'merchant', 'rider_typed', 'editorial')),
  support_votes NUMERIC(8, 4) NOT NULL DEFAULT 1.0000,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'rejected', 'takedown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_poi_alias UNIQUE (poi_id, alias_text)
);
```

### 3.3 Bidirectional Civic Dictionary & Transliteration Engine
When an entity possesses a name in only one script (e.g. entered via Latin query or Bengali surveyor form), the Stage 010 bilingual engine generates the corresponding counterpart using a high-precision civic term dictionary and phonetic rules:

```typescript
// utils-server/bilingualCivicDictionary.ts

export const CIVIC_TERM_DICTIONARY: Record<string, { en: string; bn: string }> = {
  // Healthcare & Emergency
  hospital: { en: 'Hospital', bn: 'হাসপাতাল' },
  clinic: { en: 'Clinic', bn: 'ক্লিনিক' },
  pharmacy: { en: 'Pharmacy', bn: 'ফার্মেসি' },
  diagnostic: { en: 'Diagnostic Center', bn: 'ডায়াগনস্টিক সেন্টার' },
  
  // Civic & Government
  thana: { en: 'Police Station', bn: 'থানা' },
  police_station: { en: 'Police Station', bn: 'পুলিশ স্টেশন' },
  post_office: { en: 'Post Office', bn: 'ডাকঘর' },
  court: { en: 'Court', bn: 'আদালত' },

  // Religious
  mosque: { en: 'Mosque', bn: 'মসজিদ' },
  masjid: { en: 'Jame Masjid', bn: 'জামে মসজিদ' },
  temple: { en: 'Mandir', bn: 'মন্দির' },
  church: { en: 'Church', bn: 'গির্জা' },

  // Transit & Infrastructure
  station: { en: 'Station', bn: 'স্টেশন' },
  terminal: { en: 'Terminal', bn: 'টার্মিনাল' },
  bus_stand: { en: 'Bus Stand', bn: 'বাস স্ট্যান্ড' },
  airport: { en: 'Airport', bn: 'বিমানবন্দর' },
  railway: { en: 'Railway Station', bn: 'রেলওয়ে স্টেশন' },
  bridge: { en: 'Bridge', bn: 'সেতু' },
  flyover: { en: 'Flyover', bn: 'ফ্লাইওভার' },

  // Commercial & Retail
  market: { en: 'Market', bn: 'বাজার' },
  shopping_mall: { en: 'Shopping Mall', bn: 'শপিং মল' },
  plaza: { en: 'Plaza', bn: 'প্লাজা' },
  tower: { en: 'Tower', bn: 'টাওয়ার' },
  bhaban: { en: 'Bhaban', bn: 'ভবন' },

  // Education
  school: { en: 'School', bn: 'স্কুল' },
  college: { en: 'College', bn: 'কলেজ' },
  university: { en: 'University', bn: 'বিশ্ববিদ্যালয়' },
  madrasa: { en: 'Madrasa', bn: 'মাদ্রাসা' },

  // Urban Structure
  road: { en: 'Road', bn: 'রোড' },
  street: { en: 'Street', bn: 'রাস্তা' },
  lane: { en: 'Lane', bn: 'গলি' },
  sector: { en: 'Sector', bn: 'সেক্টর' },
  block: { en: 'Block', bn: 'ব্লক' },
  avenue: { en: 'Avenue', bn: 'এভিনিউ' },
  gate: { en: 'Gate', bn: 'গেট' },
  circle: { en: 'Golchottor', bn: 'গোলচত্বর' }
};
```

---

## 4. The Post-Trip Verification Prompt UI & Operational Safeguards

When a passenger completes a trip to a high-density destination that possesses strong Layer 2 spatial evidence but lacks an authoritative Tier 1 ground-surveyed name, the Ride mobile client activates the **Post-Trip Verification Prompt**:

```
┌────────────────────────────────────────────────────────┐
│                   Ride Trip Complete                   │
│                                                        │
│               How was your ride today?                 │
│                      ★★★★★                             │
│                                                        │
│  ────────────────────────────────────────────────────  │
│                                                        │
│   Help improve maps for your neighborhood:             │
│   What is this building or destination called?         │
│                                                        │
│   [ Enter place name...                              ] │
│                                                        │
│   Or tap a common suggestion:                          │
│   ┌────────────────┐  ┌──────────────┐  ┌────────────┐ │
│   │ Baitul Aman    │  │ Road 4 Gate  │  │ Khan Tower │ │
│   └────────────────┘  └──────────────┘  └────────────┘ │
│                                                        │
│             [ Skip ]              [ Submit ]           │
└────────────────────────────────────────────────────────┘
```

### 4.1 Strict Sampling & Anti-Fraud Controls
1. **Selective Sampling Rate ($< 10\%$):** Triggered on less than 10% of qualifying completed trips. If an entity already has `provenance->>'tier' = 'tier_1'`, the prompt is **never** shown.
2. **Strictly Non-Incentivized Invariant:** To prevent fraudulent farming and coordinated poisoning:
   - Zero loyalty points awarded.
   - Zero ride discount vouchers or promo codes.
   - Zero wallet cash credits.
   - User participation is entirely voluntary civic contribution.
3. **One Submission Per Rider Per Place Per Publication Cycle:** A rider pseudonym can contribute at most **one label** per destination entity per 30-day window. Subsequent submissions from the same rider for that entity are discarded before ledger entry.
4. **Client Instrumentation Telemetry:**
   - `post_trip_prompt_shown`: Instrumented on display.
   - `post_trip_prompt_dismissed`: Instrumented on explicit "Skip" or background tap.
   - `post_trip_text_submitted`: Instrumented on manual text entry.
   - `post_trip_chip_selected`: Instrumented on suggestion chip selection.

### 4.2 Post-Trip Ingestion Schema (`dpmaps.post_trip_labels`)
Raw passenger label submissions are stored in an append-only relational ledger:

```sql
CREATE TABLE dpmaps.post_trip_labels (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  h3_res10 VARCHAR(15) NOT NULL,
  submitted_text VARCHAR(120) NOT NULL,
  normalized_text VARCHAR(120) NOT NULL,
  submission_type VARCHAR(16) NOT NULL CHECK (submission_type IN ('text_entry', 'chip_selection')),
  pseudonym_hash CHAR(64) NOT NULL,
  trip_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rider_poi_cycle UNIQUE (poi_id, pseudonym_hash)
);

CREATE INDEX idx_post_trip_labels_poi ON dpmaps.post_trip_labels (poi_id);
CREATE INDEX idx_post_trip_labels_h3 ON dpmaps.post_trip_labels (h3_res10);
```

---

## 5. Multi-Stage Sanitizer & PII Firewall

```
[ Raw Candidate String ]
          │
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. Length Bounds Check: 3 <= length <= 80 characters                                   │
│ 2. PII / Phone Number Masking: 11-digit mobile numbers (ASCII & Bengali) = REJECT      │
│ 3. Residential Structure Filter: Flat, Apartment, Floor, House Holding = REJECT        │
│ 4. Obscenity & Harassment Lexicon: Local Bengali/Banglish/English vulgarities = REJECT │
│ 5. Commercial Spam Filter: URLs, "Call for rent", "For sale", price tags = REJECT      │
│ 6. Conversational Clutter Stripping: "er samne", "opposite to", "kache" = STRIPPED    │
│ 7. Title-Case & Abbreviation Normalization: "rd" -> "Road", "sec" -> "Sector" = EXPAND │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
[ Clean Presentation Candidate ]
```

### 5.1 Conversational Clutter & Preposition Stripping
Riders frequently append navigational instructions to search strings. The Stage 010 normalizer strips these conversational artifacts:

| Input String | Detected Suffix / Artifact | Normalized Canonical Name |
|---|---|---|
| *"Dhanmondi 27 er samne"* | *"er samne"* (in front of) | *"Dhanmondi Road 27"* |
| *"Arong er ultapash"* | *"er ultapash"* (opposite side of) | *"Aarong"* |
| *"Labaid er pashe"* | *"er pashe"* (beside) | *"Labaid Hospital"* |
| *"Baitul Aman er kache"* | *"er kache"* (near) | *"Baitul Aman"* |
| *"Square Hospital main gate"* | Retained (*"Gate"* is physical curb feature) | *"Square Hospital Main Gate"* |

---

## 6. Implementation: Production Naming Sanitizer & Worker

```typescript
// utils-server/namingSanitizer.ts
import { CIVIC_TERM_DICTIONARY } from './bilingualCivicDictionary';

const BANNED_PATTERNS = [
  // 1. Mobile Phone Numbers (ASCII and Bengali digits)
  /\b(01[3-9]\d{8})\b/,
  /\b(০১[৩-৯][০-৯]{8})\b/,

  // 2. Residential Units & Private Living Quarters
  /\b(flat|apt|apartment|suite)\s*#?\s*\d+[a-z]?\b/i,
  /\b(floor|tola)\s*#?\s*\d+\b/i,
  /\b([১-৯][০-৯]?\s*(তলা|ফ্ল্যাট))\b/,

  // 3. Private House Holdings (routed to user private places only)
  /\b(house|holding)\s*#?\s*\d+[\/\-]?\d*\b/i,
  /\b(বাড়ি|হোল্ডিং)\s*#?\s*[০-৯]+[\/\-]?[০-৯]*\b/,

  // 4. Commercial Spam & Rental Notices
  /\b(call|contact|rent|to-let|sale|basha\s*bhara|ভাড়া|বিক্রি)\b/i,
  /https?:\/\/\S+/,

  // 5. Bengali, Banglish & English Obscenities / Slurs
  /\b(fuck|shit|balsal|khankir|chudirbhai|magir|harami|gandumar|kutta|shobai)\b/i
];

const CONVERSATIONAL_SUFFIXES = [
  /\s+(er\s+samne|er\s+shamne|er\s+samney)$/i,
  /\s+(er\s+pashe|er\s+pashey|er\s+kache|er\s+kachey)$/i,
  /\s+(er\s+ultapash|er\s+ulposh|opposite\s+to|opp\s+to)$/i,
  /\s+(এর\s+সামনে|এর\s+পাশে|এর\s+কাছে|এর\s+উল্টাপাশে)$/
];

const ABBREVIATION_MAP: Record<string, string> = {
  rd: 'Road',
  sec: 'Sector',
  blk: 'Block',
  hosp: 'Hospital',
  stn: 'Station',
  jfp: 'Jamuna Future Park',
  dmc: 'Dhaka Medical College',
  buet: 'BUET',
  du: 'Dhaka University'
};

export interface SanitizedNameResult {
  valid: boolean;
  canonical_name?: string;
  bangla_name?: string;
  rejection_reason?: string;
}

/**
 * Sanitizes and formats candidate display names for Layer 3 presentation
 */
export function sanitizeAndFormatDisplayName(rawInput: string): SanitizedNameResult {
  if (!rawInput) {
    return { valid: false, rejection_reason: 'Empty input string' };
  }

  let text = rawInput.trim();

  // Length bounds
  if (text.length < 3 || text.length > 80) {
    return { valid: false, rejection_reason: `Length out of bounds (${text.length} chars, must be 3-80)` };
  }

  // Check prohibited PII and obscenity patterns
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      return { valid: false, rejection_reason: 'Matches prohibited PII, residential holding, or profanity filter' };
    }
  }

  // Strip conversational suffixes
  for (const suffix of CONVERSATIONAL_SUFFIXES) {
    text = text.replace(suffix, '').trim();
  }

  // Detect script (Bengali vs Latin)
  const hasBengali = /[\u0980-\u09FF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);

  let formattedCanonical: string | undefined;
  let formattedBangla: string | undefined;

  if (hasLatin) {
    // Latin Title Casing & Abbreviation Expansion
    const words = text.split(/\s+/).map(w => {
      const lower = w.toLowerCase();
      if (ABBREVIATION_MAP[lower]) {
        return ABBREVIATION_MAP[lower];
      }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
    formattedCanonical = words.join(' ');
  }

  if (hasBengali) {
    formattedBangla = text; // Preserved in Unicode NFC
  }

  return {
    valid: true,
    canonical_name: formattedCanonical,
    bangla_name: formattedBangla
  };
}
```

### 6.2 Tier 2 Post-Trip Label Aggregation Worker

```typescript
// workers/postTripAggregationWorker.ts
import { Pool, PoolClient } from 'pg';
import { sanitizeAndFormatDisplayName } from '../utils-server/namingSanitizer';

export async function aggregatePostTripLabels(
  pool: Pool,
  evalCutoff: Date
): Promise<{ promotedCount: number; aliasCount: number }> {
  const client: PoolClient = await pool.connect();
  let promotedCount = 0;
  let aliasCount = 0;

  try {
    await client.query('BEGIN');

    // Fetch unverified POIs with active post-trip label submissions
    const poisQuery = `
      SELECT DISTINCT p.id, p.canonical_name, p.bangla_name
      FROM dpmaps.public_pois p
      JOIN dpmaps.post_trip_labels ptl ON ptl.poi_id = p.id
      WHERE (p.provenance->>'tier') IS DISTINCT FROM 'tier_1'
        AND ptl.created_at >= $1 - INTERVAL '30 days'
        AND ptl.created_at < $1
    `;
    const poisRes = await client.query(poisQuery, [evalCutoff]);

    for (const poi of poisRes.rows) {
      // Aggregate label consensus for this POI
      const labelsRes = await client.query(
        `SELECT 
          normalized_text, 
          COUNT(DISTINCT pseudonym_hash) AS distinct_riders
         FROM dpmaps.post_trip_labels
         WHERE poi_id = $1
         GROUP BY normalized_text
         ORDER BY distinct_riders DESC`,
        [poi.id]
      );

      const totalSubmissions = labelsRes.rows.reduce(
        (sum, r) => sum + parseInt(r.distinct_riders, 10), 0
      );

      // Quorum Check: At least 5 distinct rider submissions
      if (totalSubmissions < 5) continue;

      const topCandidate = labelsRes.rows[0];
      const agreementShare = parseInt(topCandidate.distinct_riders, 10) / totalSubmissions;

      // Consensus Check: >= 60% agreement on top string
      if (agreementShare >= 0.60) {
        const sanitized = sanitizeAndFormatDisplayName(topCandidate.normalized_text);
        if (sanitized.valid) {
          // Promote to Tier 2 Canonical Display Name
          await client.query(
            `UPDATE dpmaps.public_pois SET
              canonical_name = COALESCE($1, canonical_name),
              bangla_name = COALESCE($2, bangla_name),
              provenance = provenance || '{"tier": "tier_2", "verified_by": "post_trip_consensus"}'::jsonb,
              updated_at = NOW()
             WHERE id = $3`,
            [sanitized.canonical_name, sanitized.bangla_name, poi.id]
          );
          promotedCount++;

          // Secondary candidates (>= 20% share) recorded as aliases
          for (let i = 1; i < labelsRes.rows.length; i++) {
            const runnerUp = labelsRes.rows[i];
            const runnerUpShare = parseInt(runnerUp.distinct_riders, 10) / totalSubmissions;
            if (runnerUpShare >= 0.20) {
              const aliasSanitized = sanitizeAndFormatDisplayName(runnerUp.normalized_text);
              if (aliasSanitized.valid && aliasSanitized.canonical_name) {
                await client.query(
                  `INSERT INTO dpmaps.poi_aliases (
                    poi_id, alias_text, alias_type, source, support_votes, status
                  ) VALUES ($1, $2, 'colloquial', 'rider_typed', $3, 'active')
                  ON CONFLICT (poi_id, alias_text) DO UPDATE 
                  SET support_votes = dpmaps.poi_aliases.support_votes + EXCLUDED.support_votes`,
                  [poi.id, aliasSanitized.canonical_name, runnerUpShare]
                );
                aliasCount++;
              }
            }
          }
        }
      }
    }

    await client.query('COMMIT');
    return { promotedCount, aliasCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

---

## 7. Unit Testing Matrix & Sanitization Verification

| Test Case | Raw Input Candidate String | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-010-01** | *"Flat 4B, House 12, Road 7"* | **REJECTED** | Matches residential flat and holding pattern (private address). |
| **TC-010-02** | *"Dhanmondi 27 er samne"* | **PASSED** (*"Dhanmondi Road 27"*) | Conversational suffix *"er samne"* stripped; *"27"* expanded. |
| **TC-010-03** | *"01711223344"* | **REJECTED** | 11-digit mobile phone number detected and dropped. |
| **TC-010-04** | *"০১৭১১২২৩৩৪৪"* | **REJECTED** | Bengali digit 11-digit mobile phone number dropped. |
| **TC-010-05** | *"Baitul Aman Jame Masjid"* | **PASSED** (*"Baitul Aman Jame Masjid"*) | Clean religious landmark title-cased. |
| **TC-010-06** | *"Square Hosp er pashe"* | **PASSED** (*"Square Hospital"*) | Abbreviation *"hosp"* expanded, *"er pashe"* stripped. |
| **TC-010-07** | *"balsal er dokan"* | **REJECTED** | Local obscenity (*"balsal"*) detected. |
| **TC-010-08** | *"To-let 3 room call now"* | **REJECTED** | Commercial rental notice dropped. |
| **TC-010-09** | Post-trip label with 4 submissions | **IGNORED** | Quorum failure ($4 < 5$ distinct riders). |
| **TC-010-10** | Post-trip label with 55% agreement | **IGNORED** | Consensus failure ($55\% < 60\%$). |
| **TC-010-11** | Post-trip label with 70% agreement | **PROMOTED** | Meets quorum ($\ge 5$) and consensus ($\ge 60\%$) $\rightarrow$ Tier 2 promotion. |

---

## 8. Deliverables & Definition of Done

- [ ] **Sanitizer Engine:** `utils-server/namingSanitizer.ts` fully implemented and verified against the unit test suite.
- [ ] **Bilingual Civic Dictionary:** `CIVIC_TERM_DICTIONARY` covering $\ge 100$ urban navigation terms deployed.
- [ ] **Database Schema:** `dpmaps.post_trip_labels` table created and integrated with `dpmaps.public_pois` and `dpmaps.poi_aliases`.
- [ ] **Mobile UI:** Non-incentivized post-trip label bottom sheet prompt implemented in mobile client with $<10\%$ sampling gate and telemetry logging.
- [ ] **Aggregation Worker:** `workers/postTripAggregationWorker.ts` deployed on the monthly publication cadence with quorum ($\ge 5$) and consensus ($\ge 60\%$) enforcement.
- [ ] **Clean-Room Verification:** Verified that Tier 4 ephemeral vendor strings are never written to `public_pois` or `poi_aliases`.
