# Stage 012: Anti-Manipulation & Sybil Resistance Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-012 (Revision 2.1 — Side-Table Invalidation, Layered Caps & Burst Quarantine)
**Stage:** 12 of 16 (Security, Fraud & Sybil Defense Engineering)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§12, §12.1)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Target Phase:** Phase 1 (Dual-Connected Launch & Operational Defense)
**Primary Dependencies:** Stages 002, 003 (Rev 2.5 schema of record), 009, 011

---

## 1. Executive Summary & Objective

Map coordinates and search rank govern consumer behavior and merchant foot traffic, so competitors and malicious actors have economic incentives to manipulate the engine: location spoofing, search hijacking, collusive "ghost ride" farming, and takedown vandalism. Stage 012 delivers defense-in-depth:

1. **5-Layer Defensive Firewall** (§3) — telemetry feasibility, device/identity entropy, vote throttling + collusion caps, swarm/velocity anomalies, merchant integrity.
2. **Layered Algorithmic Caps (F-012-2/3)** — one formula of record for per-rider, driver-cohort, and pair-collusion caps (§4).
3. **Burst Quarantine (F-012-4)** — > 5× baseline velocity in an H3 res-10 cell within 48 h quarantines the cluster in Redis set `dpmaps:quarantine:clusters` pending monthly audit.
4. **Side-Table Invalidation (F-012-1/2)** — all Sybil/collusion findings write `dpmaps.ledger_invalidations`; the ledger is **never mutated** (append-only).
5. **Merchant Integrity Boundary** — verified merchants can never buy, bid on, or distort organic ranking (zero paid-placement parameters exist).

> [!CAUTION]
> Fraud telemetry runs behind the Stage 002 Legal Gate (Items 3, 7, 14–17); device fingerprinting is `[UNVERIFIED]` against consent requirements — counsel Item 3.

---

## 2. Threat Model (Bangladesh)

| Threat | Attack | Defense |
|---|---|---|
| SIM-swarm / burners | 20–50 SIMs fake 15 distinct riders for Gate 1 | device entropy, account-age weighting, OTP gate |
| Driver–rider collusion | repeat short "ghost" rides force a pin | pair caps (§4), driver cohort cap, burst quarantine |
| Mock-location spoofing | emulators fake drop-offs | speed-variance filter, road snapping (§3 L1) |
| Keyword hijacking | competitor relinks queries to rival POI | 30 m spatial convergence (007), Gate 5 margin (009) |
| Takedown vandalism | swamped false reports | traveler-qualified reporting (011), 1 report/user/day |

---

## 3. The 5-Layer Defensive Firewall

```
[ Completed Trip Event ]
  L1 Telemetry feasibility: duration ≥ 120 s, distance ≥ 200 m, speed ≤ 120 km/h
     [ESTIMATE thresholds]; ≥ 20 GPS breadcrumbs; Var(v) > 0.05 m²/s² [ESTIMATE];
     drop-off snaps to drivable edge ≤ 35 m [ESTIMATE]
  L2 Identity entropy: 1 vote/device/cluster/30 d; phone-verified; accounts < 14 d
     cannot satisfy quorum [ESTIMATE]
  L3 Caps (§4): per-rider 1/7 d & ≤ 3/90 d; pair cap; driver cohort ≤ 25 %
  L4 Swarm/velocity: young-account ratio > 40 % → quarantine [ESTIMATE];
     weekly volume > 3× trailing-4-week average → hold [ESTIMATE];
     > 5× baseline 48-h velocity in res-10 cell (same-window baseline; absolute floor
     10 votes [ESTIMATE] so empty cells cannot self-trigger) → dpmaps:quarantine:clusters
     (F-012-4; refinement: unit-matched windows);
     > 60 % of votes in < 48 h → +2 weeks traffic (009 §3.3)
  L5 Merchant integrity: no paid placement, no bid parameters, brand-collision alias checks
  ── all passed ──► record vote in dpmaps.trip_evidence_ledger (append-only)
```

---

## 4. Caps & Formulations (single source of record — F-012-2)

**Per-rider cluster cap** (ingestion: 009 §3.3; durable recount at publication):
$$w_R = w_{base}\ \text{if}\ \text{Trips}_{7d}(R,Q) = 1\ \wedge\ \text{Trips}_{90d}(R,Q) \le 3;\ \ 0\ \text{otherwise}$$

**Driver cohort cap:** $\max_d \text{Trips}(d,Q)/\text{TotalTrips}(Q) \le 0.25$ (denominator = cluster vote count).

**Pair collusion cap (layered):**
- Landmark layer (this stage, work-order rule): at most **2 counted trips per (rider, driver) pair per landmark per 90 d**; later trips count 0 and register in `ledger_invalidations(reason='collusion')` when a ring pattern is confirmed.
- Cluster layer (009 §3.3, stricter, governs ingestion): max 1 counted vote per pair per `query_cluster_id` per 30 d, weight 0 after.
- Optional dampening tiers for partial evidence $[ESTIMATE]$: $\mu = 1.0$ (trips 1–2), $0.1$ (3–5), $0.0$ (> 5 + audit flag). Hard caps above always win at publication time.

**Landmark-layer enforcement point (refinement — the landmark does not exist at vote time, so this cap is a publication-time recount, not an ingestion filter):** Stage 009's gate run, before evaluating Gates 1/2/4/6 numerators, excludes surplus pair-trips over the candidate's `CellSet` votes from the trailing 90 d:

```sql
-- countable votes after pair-cap exclusion (Stage 009 gate pre-check, 012-owned rule)
WITH pair_trips AS (
  SELECT lp.pseudonym_hash AS rider, lp.driver_pseudonym_hash AS driver,
         tel.id, tel.created_at, tel.initial_weight,
         ROW_NUMBER() OVER (
           PARTITION BY lp.pseudonym_hash, lp.driver_pseudonym_hash
           ORDER BY tel.created_at) AS rn
  FROM dpmaps.trip_evidence_ledger tel
  JOIN dpmaps.ledger_pseudonyms lp
    ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at
  JOIN dpmaps.active_dedup_key adk ON lp.key_id = adk.key_id
  LEFT JOIN dpmaps.ledger_invalidations li
    ON li.ledger_id = tel.id AND li.created_at = tel.created_at
  WHERE li.ledger_id IS NULL
    AND tel.h3_res10 = ANY($1::text[])          -- candidate CellSet
    AND tel.created_at >= NOW() - INTERVAL '90 days'
)
SELECT * FROM pair_trips WHERE rn <= 2;          -- trips 3+ per pair contribute 0 weight
```

**GPS variance filter:** $\text{Var}(v) \le 0.05\ \text{m}^2/\text{s}^2$ over trips > 120 s ⇒ emulated (dropped) `[ESTIMATE]`.

---

## 5. Implementation: Fraud Filter Pipeline (schema-conformant)

```typescript
// workers/fraudFilterWorker.ts — caps at ingestion; durable recount at publication (009 gates)
export class AntiManipulationFilterService {
  async evaluateTripVote(trip: RawTripEvidence): Promise<FilterResult> {
    // L1 telemetry feasibility (§3) …
    // L2 device: fraud:device:<hash>:<cluster> EXISTS → reject (30 d)
    // L3 caps via Redis TTL-on-first-add counters (fraud:rider_week:*, fraud:rider_90d:*,
    //    fraud:pair_90d:*) — non-durable by design; Stage 009's publication SQL recounts
    //    from the ledger as the durable enforcement.
    // L4 detectors (§3) incl. F-012-4 velocity (refinement: unit-matched windows):
    //    baseline_48h = mean votes per 48-h window in the res-10 cell over trailing 28 d;
    //    trigger iff votes(cell, 48h) > 5 × baseline_48h AND votes(cell, 48h) >= 10
    //    [ESTIMATE floor — without it an empty cell self-triggers on its first vote]
    //    ⇒ SADD dpmaps:quarantine:clusters <cluster_id> (TTL 30 d); cluster held
    //    pending the monthly audit cycle.
    // L5 not a filter — structural (no paid-placement parameters anywhere).
  }
}

export async function recordInvalidation(
  db: Pool, ledgerId: number, createdAt: Date,
  reason: 'fraud_sybil' | 'burst_suppression' | 'collusion' | 'audit_purge' | 'quarantine' | 'driver_bias',
  invalidatedBy: string
): Promise<void> {
  // F-012-1/2: side-table invalidation ONLY — the ledger is append-only and never UPDATEd.
  // 'driver_bias' requires the Rev 2.6 CHECK widening; the other five are schema-of-record.
  await db.query(
    `INSERT INTO dpmaps.ledger_invalidations (ledger_id, created_at, reason, invalidated_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT (ledger_id, created_at) DO NOTHING`,
    [ledgerId, createdAt, reason, invalidatedBy]
  );
}
```

**Work-order vocabulary crosswalk (F-012-1):** `sybil_burst → 'fraud_sybil' | 'burst_suppression'`; `collusion_ring → 'collusion'`; `admin_manual → 'audit_purge'`; `driver_bias → 'driver_bias'` (Rev 2.6). The name `invalidation_type_enum` does not exist — the column is `reason VARCHAR(64)`.

---

## 6. Retroactive Invalidation & Audit Console (F-012-2)

```
1. Analyst inputs compromised pseudonym hashes →
2. INSERT dpmaps.ledger_invalidations rows for every affected (ledger_id, created_at)
   reason 'fraud_sybil'/'collusion'/'audit_purge', invalidated_by = actor        ← NOT an UPDATE
3. v_active_cluster_evidence automatically excludes invalidated rows (003 §4.4)
4. Recompute evaluateCandidateGates() for affected clusters (009)
5. Demote POIs that fall below gates (demoted/retired — never delete)
6. Audit HMAC incident record in dpmaps.provenance_events
```

```sql
-- Invalidation set build (read-only) — then fed to recordInvalidation() per row
SELECT tel.id AS ledger_id, tel.created_at
FROM dpmaps.trip_evidence_ledger tel
JOIN dpmaps.ledger_pseudonyms lp ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at
JOIN unnest(:compromised_pseudonym_hashes::text[]) pp(phash) ON pp.phash = lp.pseudonym_hash
WHERE NOT EXISTS (SELECT 1 FROM dpmaps.ledger_invalidations li
                  WHERE li.ledger_id = tel.id AND li.created_at = tel.created_at);
```

---

## 7. Merchant Integrity Boundary

Clean-room merchant onboarding (Tier 1 names/entrances only). Autocomplete relevance is 100 % organic (trip volume, proximity, linguistic match). The search API has zero parameters for `promoted_poi`/`bid_rank`/`commercial_boost` (CI audit test). Brand-collision checks block competitor-name aliases in `dpmaps.poi_aliases`.

---

## 8. Test Matrix

| TC | Scenario | Expected |
|---|---|:---:|
| TC-012-01/02 | sub-minimum duration/distance; Var(v)=0.01 | REJECTED (L1) |
| TC-012-03 | same device votes twice / 30 d | REJECTED (L2) |
| TC-012-04 | rider 2nd vote same cluster / 5 d | REJECTED (L3) |
| **TC-012-04b** | rider 4th vote same cluster / 90 d | REJECTED (≤ 3/90 d) |
| TC-012-05/06 | pair 3rd trip/30 d; 6th trip/30 d | 0.10× `[ESTIMATE]`; REJECTED + audit flag |
| **TC-012-06b** | pair 3rd counted trip per landmark / 90 d | WEIGHT 0 (landmark cap, F-012-2) |
| TC-012-07 | driver = 35 % of cluster votes | DISQUALIFIED (Gate 2 cap) |
| TC-012-08 | young-account swarm | QUARANTINED |
| **TC-012-08b** | res-10 cell votes(48 h) > 5× baseline | `dpmaps:quarantine:clusters` + held (F-012-4) |
| **TC-012-09b** | retroactive purge | `ledger_invalidations` rows; **ledger row byte-identical** (F-012-2) |
| TC-012-10 | merchant competitor alias | REJECTED (L5) |

---

## 9. Deliverables

- [ ] Fraud filter wired pre-ledger with caps of §4 as the single formula of record.
- [ ] **Zero ledger UPDATEs anywhere in the purge pipeline** (grep-enforced); invalidations exclusively via `ledger_invalidations` with schema-of-record `reason` values (F-012-1/2).
- [ ] `dpmaps:quarantine:clusters` velocity detector (5×/48 h/res-10) tested; monthly audit clears or converts to invalidation rows (F-012-4).
- [ ] Redis cap counters + durable publication recount both verified (F-012-5).
- [ ] Admin audit console recalculates affected clusters; demote-not-delete preserved.
- [ ] All thresholds `[ESTIMATE]`-labeled and admin-configurable pending replay.

---

## 10. Revision Changelog

| Revision | Date | Author / Context | Summary |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | 5-layer firewall, cap formulations, fraud pipeline, purge console, merchant boundary. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-4 audit) | **Invalidation Conformance & Cap Unification:** 1. Side-table invalidation only — purge SQL rewritten to `ledger_invalidations` inserts (ledger immutability restored, F-012-2); real `reason` vocabulary + work-order crosswalk, `driver_bias` via Rev 2.6 (F-012-1). 2. Layered pair-collusion caps unified (2 counted/pair/landmark/90 d + 009 cluster rule) (F-012-2/3). 3. 5×/48 h res-10 velocity quarantine → `dpmaps:quarantine:clusters` (F-012-4). 4. Labels, durable-recount note, TC-012-04b/06b/08b/09b (F-012-5). |
