# Stage 010: Naming Engine & Post-Trip Verification Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-010 (Revision 2.1 — 4-Tier Authority, Bilingual Gate & Lineage-Safe Post-Trip Naming)
**Stage:** 10 of 16 (Presentation Layer & Organic Verification)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§4, §9, §9.1–9.2)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Target Phase:** Phase 2 (Presentation Autonomy)
**Primary Dependencies:** Stages 002, 003 (Rev 2.4 schema of record), 007 (`scrubPii`, normalizer), 009 (identity/evidence), 011 (privacy classes)

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> The post-trip naming prompt collects rider input and requires counsel clearance on **Stage 002 Legal Matrix Item 12 (Post-Trip Prompt Consent) `[UNVERIFIED]`**, and the telemetry it generates stays behind the standard gate **Items 3, 7, 14, 15, 16, 17**. No prompt ships to production before written sign-off.

---

## 1. Executive Summary & Objective

Layer 3 governs how physical locations are formatted, verified, and presented. Naive systems publish raw keystrokes (*"dhan 27 gate er samne"*, *"mama arong er kache"*), leaking flat numbers, phones, or vulgarities. Stage 010 delivers:
1. **The 4-Tier Display Name Authority Hierarchy** (§2) — strict precedence; lower tiers never override higher.
2. **Bilingual Dual-Name Standard (F-010-2):** every **published** landmark carries both `canonical_name` and `bangla_name` (publication gate, §3), with a wired counterpart generator and `poi_aliases` provenance.
3. **Post-Trip Label Protocol (F-010-3):** submissions land in a **staging table only** (`dpmaps.post_trip_labels`, Rev 2.5) — never an instant rename; convergence + privacy filters must pass.
4. **Identity Independence (F-010-4):** display-name updates never touch the random UUIDv4 `id`; every mutation writes `dpmaps.poi_versions` lineage.

---

## 2. The 4-Tier Display Name Authority Hierarchy (F-010-1)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ TIER 1 — Survey & Merchant Onboarding (authoritative)                          │
│ Pin Tool clean-room surveys & verified merchants (source_type_enum:             │
│ 'pin_tool' / 'merchant_onboarding'). Overrides all crowdsourced strings.        │
├────────────────────────────────────────────────────────────────────────────────┤
│ TIER 2 — Post-Trip Rider Consensus (aggregated, never individual)              │
│ Quorum ≥ 5 distinct riders [ESTIMATE]; consensus ≥ 60% on one normalized       │
│ string [ESTIMATE]; runner-ups ≥ 20% [ESTIMATE] → poi_aliases. Individual       │
│ labels NEVER rename anything (F-010-3).                                        │
├────────────────────────────────────────────────────────────────────────────────┤
│ TIER 3 — Formatted Canonical Query                                             │
│ Canonical form of the leading normalized rider-typed variant (Stage 007/009)   │
│ — NEVER the raw majority string. Must clear scrubPii + the §5 sanitizer.       │
├────────────────────────────────────────────────────────────────────────────────┤
│ TIER 4 — Ephemeral Vendor Passthrough / Coarse Centroid                        │
│ Vendor suggestion text is display-only during dispatch. INVARIANT: never in    │
│ public_pois, never in poi_aliases, never in receipts, never in Meili.          │
│ Vendor disabled → administrative centroid (ADM3/4).                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Invariants:** trip votes prove a place exists (Stage 009 Layer 2) but never name it; zero raw keystrokes rendered; zero vendor text retained (Hard Rule 1).

---

## 3. Bilingual Dual-Name Standard (F-010-2)

### 3.1 Publication Gate (fixes the OR/AND contradiction)
`chk_poi_name_exists` in Stage 003 requires **at least one** name (candidates may be single-script). **Published** landmarks require **both** — enforced additively (Rev 2.5 brief):

```sql
-- Additive: bilingual requirement at publication time (candidates stay single-script OK)
ALTER TABLE dpmaps.public_pois
  ADD CONSTRAINT chk_poi_bilingual_active
  CHECK (lifecycle_status <> 'active'
         OR (canonical_name IS NOT NULL AND bangla_name IS NOT NULL));
```

### 3.2 Relational Aliases
`dpmaps.poi_aliases` is defined in Stage 003 §4.3 (schema of record — `uq_poi_alias UNIQUE (poi_id, alias_text)`, alias_type `transliteration|colloquial|acronym|misspelling`, source `surveyor|merchant|rider_typed|editorial`). This plan does **not** re-declare the table.

### 3.3 Wired Bilingual Counterpart Generator (F-010-2)
When an entity has only one script, generate the counterpart via `bilingualCivicDictionary.ts` (curated civic terms: hospital/হাসপাতাল, mosque/মসজিদ, road/রোড, sector/সেক্টর, gate/গেট, …) plus Stage 007 phonetic transliteration for remaining tokens:

```typescript
export function generateBilingualCounterpart(
  name: string, sourceScript: 'en' | 'bn'
): { generated: string; quality: 'dictionary' | 'phonetic' } {
  const tokens = tokenize(name);
  const mapped = tokens.map(t => CIVIC_TERM_DICTIONARY[slug(t)]?.[sourceScript === 'en' ? 'bn' : 'en'] ?? null);
  const fullyMapped = mapped.every(m => m !== null);
  if (fullyMapped) return { generated: mapped.join(' '), quality: 'dictionary' };
  return { generated: phoneticTransliterate(name, sourceScript), quality: 'phonetic' }; // [ESTIMATE quality]
}
```

Generated counterparts enter as `canonical_name`/`bangla_name` **only when quality = 'dictionary'**; phonetic candidates enter `poi_aliases` (`alias_type: 'transliteration'`, `status: 'pending'`) for editorial review. Every name write is lineage-recorded (§6).

---

## 4. Post-Trip Label Collection Protocol (F-010-3)

Prompt on destination arrival for entities with strong Layer 2 evidence and no Tier 1 name (`provenance->>'tier' IS DISTINCT FROM 'tier_1'`), sampled at **< 10 %** `[ESTIMATE]` of qualifying trips. The prompt also fires for **unindexed** destination cells with no `public_pois` row at all (concept paper §9 use case) — those submissions carry `poi_id NULL` and are keyed by `h3_res10` (F-010-6; aggregation path in §6.1). **Strictly non-incentivized** (zero points/vouchers/credits — Sybil-farming defense). One submission per rider per place **per publication cycle**.

```sql
-- dpmaps.post_trip_labels — Stage 003 Rev 2.5 adoption (staging only; see Part F)
CREATE TABLE dpmaps.post_trip_labels (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  h3_res10 VARCHAR(15) NOT NULL,
  submitted_text VARCHAR(120) NOT NULL,   -- scrubbed at write (scrubPii + sanitizer)
  normalized_text VARCHAR(120) NOT NULL,  -- Stage 007 normalized form
  submission_type VARCHAR(16) NOT NULL CHECK (submission_type IN ('text_entry', 'chip_selection')),
  pseudonym_hash CHAR(64) NOT NULL,       -- ledger-style pseudonym
  trip_hash CHAR(64) NOT NULL,            -- HMAC-SHA256(trip_id, IngestionSalt)
  publication_cycle VARCHAR(32) NOT NULL, -- cycle-bounded uniqueness (30-day claim)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rider_poi_cycle UNIQUE (poi_id, pseudonym_hash, publication_cycle)
);
CREATE INDEX idx_post_trip_labels_poi ON dpmaps.post_trip_labels (poi_id);
CREATE INDEX idx_post_trip_labels_h3 ON dpmaps.post_trip_labels (h3_res10);
```

Client telemetry (`post_trip_prompt_shown/dismissed/text_submitted/chip_selected`) is aggregated metrics only — no keystroke streams (Hard Rule 8).

---

## 5. Multi-Stage Sanitizer & PII Firewall

```
[ Raw Candidate ] → scrubPii (Stage 007 — phones/emails, Bengali digits, delimiters)
      → 1. Length 3–80   2. PII residue check (delimited phones)   3. Residential classes
      → 4. Obscenity lexicon (bn/banglish/en)   5. Commercial spam   6. Clutter stripping
      → 7. Title-case + abbreviation expansion + structured "Road N" heuristic
      → [ Clean Presentation Candidate ]
```

**Stage 011 privacy classes (categorical):** unit/flat/floor markers, resident/family names, relationship phrases (*"Mamur bari"*), Home/Work labels — **REJECT**, never strip-and-publish.

**Clutter stripping (suffix + phrase):** *"er samne"*, *"er pashe"*, *"er kache"*, *"er ultapash"*, *"opposite to"* (Bangla equivalents included).

**Structured "Road N" heuristic (fixes TC-010-02):** a bare numeral following a known neighborhood/area token with no other entity headword expands Dhaka-style — *"Dhanmondi 27"* → *"Dhanmondi Road 27"* `[ESTIMATE heuristic — area token list maintained with Stage 013; disable flag in system_config]`.

**Phone residue:** delimited forms (e.g. `017-11223344`) are caught because `scrubPii` runs **first** (F-010-5); the sanitizer's own patterns remain as belt-and-braces.

```typescript
// utils-server/namingSanitizer.ts (abridged, conformance-fixed)
import { scrubPii } from './textNormalizer';
import { generateBilingualCounterpart } from './bilingualCivicDictionary';

export function sanitizeAndFormatDisplayName(rawInput: string): SanitizedNameResult {
  let text = scrubPii(rawInput).trim();                    // F-010-5: PII first
  if (text.length < 3 || text.length > 80) return { valid: false, rejection_reason: 'length' };
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) return { valid: false, rejection_reason: 'pii/residential/profanity' };
  }
  for (const suffix of CONVERSATIONAL_SUFFIXES) text = text.replace(suffix, '').trim();
  text = applyRoadNHeuristic(text);                        // "Dhanmondi 27" → "Dhanmondi Road 27"

  const hasBengali = /[\u0980-\u09FF]/.test(text);
  const hasLatin = /[a-zA-Z]/.test(text);
  let canonical = hasLatin ? titleCaseExpand(text) : undefined;
  let bangla = hasBengali ? text.normalize('NFC') : undefined;

  // Bilingual completion (F-010-2): dictionary-quality counterpart fills the gap
  if (canonical && !bangla) {
    const g = generateBilingualCounterpart(canonical, 'en');
    if (g.quality === 'dictionary') bangla = g.generated;
  } else if (bangla && !canonical) {
    const g = generateBilingualCounterpart(bangla, 'bn');
    if (g.quality === 'dictionary') canonical = g.generated;
  }
  return { valid: true, canonical_name: canonical, bangla_name: bangla };
}
```

---

## 6. Aggregation Worker (lineage-safe — F-010-1, F-010-4)

Monthly cadence, same maintenance window as Stage 009. For each candidate POI:
1. Aggregate staged labels by `normalized_text` (distinct `pseudonym_hash`); quorum ≥ 5 `[ESTIMATE]`; consensus ≥ 60 % `[ESTIMATE]`.
2. Sanitize the winner (§5). **Never** promote an individual label.

**§6.1 Unindexed-cluster path (F-010-6, X-10):** rows with `poi_id IS NULL` aggregate by `(h3_res10, normalized_text)` with the same quorum/consensus. A passing result **seeds a Stage 009 candidate** (convergent name evidence attached to the cell) — it never writes a display name and never mints a place by itself; Stage 009's gates decide existence. This is the concept paper §9 "name unindexed spatial clusters" flow.

3. **Lineage write before any rename (F-010-4):**

```typescript
// version row FIRST, then the name UPDATE — id never changes
await client.query(
  `INSERT INTO dpmaps.poi_versions
     (poi_id, version_number, canonical_name, bangla_name,
      canonical_payload_hash, audit_hmac, release_id)
   SELECT $1,
          COALESCE((SELECT MAX(version_number) FROM dpmaps.poi_versions WHERE poi_id = $1), 0) + 1,
          p.canonical_name, p.bangla_name,
          encode(digest(p.id::text || COALESCE(p.canonical_name,'') || COALESCE(p.bangla_name,''), 'sha256'), 'hex'),
          $2, $3
     FROM dpmaps.public_pois p WHERE p.id = $1`,
  [poi.id, auditHmac, currentReleaseId]
);
await client.query(
  `UPDATE dpmaps.public_pois SET
     canonical_name = COALESCE($1, canonical_name),
     bangla_name    = COALESCE($2, bangla_name),
     provenance     = provenance || '{"tier": "tier_2", "verified_by": "post_trip_consensus"}'::jsonb,
     updated_at     = NOW()
   WHERE id = $3`,
  [sanitized.canonical_name, sanitized.bangla_name, poi.id]
);
```

4. Runner-ups ≥ 20 % `[ESTIMATE]` → `poi_aliases` (`colloquial`, `rider_typed`) via `ON CONFLICT (poi_id, alias_text)` (uq constraint exists).
5. The bilingual publication gate (§3.1) is a DB invariant — workers cannot publish single-script names.
6. **Identity independence tests (F-010-4):** after any rename/metadata update, `public_pois.id` and its bookmarks remain byte-identical; `superseded_by` is used only by Stage 009's challenger flow.

---

## 7. Unit Testing Matrix

| Test Case | Input / Scenario | Expected | Rationale |
|---|---|:---:|---|
| TC-010-01 | *"Flat 4B, House 12, Road 7"* | REJECTED | residential classes (Stage 011) |
| TC-010-02 | *"Dhanmondi 27 er samne"* | PASSED → *"Dhanmondi Road 27"* | clutter strip + Road-N heuristic |
| TC-010-03/04 | *"01711223344"* / *"০১৭১১২২৩৩৪৪"* | REJECTED | phones incl. Bengali digits |
| **TC-010-04b** | *"017-1122-3344"* | REJECTED | delimited phone — scrubPii-first (F-010-5) |
| TC-010-05/06 | *"Baitul Aman Jame Masjid"* / *"Square Hosp er pashe"* | PASSED | clean title-casing; abbreviations |
| TC-010-07/08 | obscenity / *"To-let 3 room call now"* | REJECTED | lexicon / spam |
| TC-010-09/10/11 | 4 submissions / 55 % agreement / 70 % agreement | IGNORED / IGNORED / PROMOTED | quorum & consensus `[ESTIMATE]` |
| **TC-010-12** | single rider submits label twice in one cycle | SECOND DISCARDED | `uq_rider_poi_cycle` |
| **TC-010-13** | Tier 2 rename applied | `poi_versions` row written; `id` unchanged | F-010-4 lineage |
| **TC-010-14** | worker attempts single-script publish | BLOCKED by `chk_poi_bilingual_active` | F-010-2 |
| **TC-010-15** | Tier 4 vendor text offered as name | REJECTED at ingest | clean-room invariant |

---

## 8. Deliverables & Definition of Done

- [ ] Sanitizer with `scrubPii`-first ordering + delimited-phone test (TC-010-04b) + Road-N heuristic flag (F-010-5).
- [ ] Bilingual publication gate deployed (Rev 2.5 CHECK); counterpart generator wired; dictionary-quality-only auto-fill (F-010-2).
- [ ] `dpmaps.post_trip_labels` adopted (Rev 2.5) with cycle-bounded uniqueness; staging-only rule enforced (F-010-3).
- [ ] Aggregation worker writes `poi_versions` lineage before every rename; UUID stability tests (F-010-4).
- [ ] Thresholds (≥ 5 riders, ≥ 60 %, ≥ 20 %, < 10 % sampling) admin-configurable `[ESTIMATE]`, replayed on real data before enforcement.
- [ ] Tier 4 zero-retention verified (TC-010-15); legal gate on Item 12 enforced in the release checklist.

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | 4-tier hierarchy, bilingual dictionary, post-trip prompt, sanitizer, aggregation worker. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-3 audit) | **Bilingual Gate, Staging Conformance & Lineage:**<br>1. **Bilingual gate (F-010-2):** OR/AND contradiction fixed — `chk_poi_bilingual_active` requires both names at `active`; counterpart generator actually wired (dictionary-quality auto-fill, phonetic → aliases).<br>2. **Staging conformance (F-010-3):** `post_trip_labels` moved to Rev 2.5 brief; `UNIQUE (poi_id, pseudonym_hash, publication_cycle)` matches the per-cycle rule; scrubbed writes.<br>3. **Lineage (F-010-1/4):** `poi_versions` written before every rename; UUID-stability tests; individual labels never rename.<br>4. **Conformance (F-010-5):** duplicate `poi_aliases` DDL replaced by schema reference; scrubPii-first sanitizer (delimited phones); Road-N heuristic for TC-010-02; `[ESTIMATE]` labels; legal gate (Item 12) caution block. |
