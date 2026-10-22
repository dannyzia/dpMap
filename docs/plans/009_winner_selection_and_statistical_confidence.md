# Stage 009: Winner Selection & Statistical Confidence Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-009 (Revision 2.1 — UUIDv4 Identity, View-Based Gate Evaluation & Verified Wilson Thresholds)
**Stage:** 9 of 16 (Learning Engine & Publication Statistics)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§4, §5.1–5.4, §7.1–7.2, §8.1–8.3, §12.1)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Target Phase:** Phase 2 (Autonomous Learning / Publication)
**Primary Dependencies:** Stage 002, Stage 003 (Rev 2.3 schema of record), Stage 007, Stage 008, Stage 010 (naming), Stage 011 (suppression)

---

## 1. Executive Summary & Objective

In crowdsourced map learning, naive majority voting is fatal: if 50 riders search for a university campus and the driver stops at a tea stall 250 m away, naive majority publishes the tea stall as the campus gate. Single-cycle voting also causes spatial oscillation between competing entrances, corrupting bookmarks and dispatch pins.

Stage 009 converts append-only completed-trip evidence into high-confidence physical places (`dpmaps.public_pois`) through a mathematically verified **Winner Selection & Publication Engine**:

1. **Three-Layer Learning Engine:** strict isolation between Relevance (what riders typed), Identity (where vehicles stop), and Display Name (Stage 010's hierarchy). Trip votes never alone decide display names.
2. **Immutable Random UUIDv4 Identity:** place IDs are minted once with `gen_random_uuid()` and never derived from names or H3 cells (Stage 003 §4.2). Renames and geometry refinements never change the ID; lineage lives in `dpmaps.poi_versions` and `superseded_by`.
3. **135-Day Key Schedule Integration (Stage 003 Rev 2.1):** distinct-rider counts use the canonical view `dpmaps.v_active_cluster_evidence`, which joins `dpmaps.active_dedup_key` — eliminating the 5× multi-key fan-out overcounting.
4. **Spatial Consolidation:** DBSCAN (30 m, metric-corrected) merges boundary-split drop-offs, and dynamic $k=1$ H3 neighbor rings cover sprawling landmarks — evaluated at query time, never mutating ledger rows (F-009-4).
5. **Verified Statistical Gates:** Kish effective sample size + 95 % Wilson score. The Gate 6 threshold is **proved**: at $p = 0.70$, $W_{\text{lower}} > 0.5 \iff n_{\text{eff}} \ge 25$ (F-009-3 — the "≥ 23" figure is mathematically false and is not used).
6. **Gate 5 Repaired (F-009-2):** margin $s_1 - s_2 \ge 0.20$ evaluated against runner-up **cells** preserved in `dpmaps.v_active_cluster_evidence` (unfiltered); with a proved binding condition for consolidated multi-cell candidates.
7. **Two-Cycle Challenger Stability:** a challenger must win two consecutive monthly publication cycles before superseding an incumbent. Stale places are **demoted, never deleted** (F-009-5).
8. **Sybil & Collusion Defense:** pairwise rider–driver caps, per-rider cluster caps (1/week, ≤ 3 per 90 d), driver cohort cap (≤ 25 %), burst quarantine, and `dpmaps.suppressions` integration (Stage 011).

---

## 2. The Three-Layer Learning Engine

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Relevance — maps typed queries to place IDs (rider votes, phonetic keys).  │
│ Layer 2: Identity — where vehicles physically stop (clusters, H3, point_type).      │
│ Layer 3: Display Name — Stage 010's 4-tier authority hierarchy ONLY:                │
│   Tier 1 Pin Tool / merchant names → Tier 2 post-trip labels →                      │
│   Tier 3 formatted canonical query → Tier 4 ephemeral vendor passthrough.           │
└────────────────────────────────────────────────────────────────────────────────────┘
```

> **Cardinal Rule:** Trip votes power Layer 1, partly establish Layer 2, and **never alone decide Layer 3**. A cluster of trips establishes that a destination exists at these coordinates; its published name comes from Stage 010 — never from a cell suffix or a raw majority string.

---

## 3. Atomic Vote Definition & Ingestion Safeguards

### 3.1 The Atomic Vote Unit
$$\text{Vote} = \langle Q_{\text{cluster}}, \text{DropoffPoint}(lat,lng), C_{\text{trip}}, w_{\text{base}}, t_{\text{completion}} \rangle$$

- $Q_{\text{cluster}}$: Stage 007 normalized query cluster ID (typed text before selection; ≤ 80 chars).
- $\text{DropoffPoint}$: driver handset end-of-trip GPS fix (ground truth), Kalman-filtered, curb-snapped.
- $C_{\text{trip}}$: **key-independent** trip hash per Stage 003 §4.4:
  $$\text{trip\_hash} = \mathrm{HMAC\text{-}SHA256}(\text{trip\_id}, \text{IngestionSalt})$$
  (static operational ingestion salt — not a window key; enables retry idempotency via `uq_ledger_trip`).
- $w_{\text{base}}$: **1.00** full query (typed ≥ 4 chars or explicit selection), **0.35** prefix-only (relevance only — cannot establish identity or mint places), **1.25** merchant-verified trip.
- $t_{\text{completion}}$: immutable completion timestamp for read-time decay.

### 3.2 Pre-Ingestion Sanitization & Exclusion Pipeline
```
1. Trip completed (cancelled/rerouted = DROP)
2. Telemetry realism: duration >= 120 s, distance >= 200 m, speed <= 120 km/h [ESTIMATE thresholds]
3. GPS integrity: speed-variance anti-spoofing check
4. PII & structural filter: phone/email patterns (Bengali digits normalized first),
   personal names, unit/flat markers = DROP (Stage 011 §3)
5. Clean-room provenance: zero vendor strings/IDs/polylines = PASS
6. Suppression check: Redis Set dpmaps:suppression:active_place_ids + dpmaps.suppressions
   (Redis Set / sliding-window semantics — NOT a Bloom filter)
→ Ingest into dpmaps.trip_evidence_ledger + dpmaps.ledger_pseudonyms
```

### 3.3 Sybil & Collusion Resistance Rules
1. **Pairwise Rider–Driver Cap:** within 30 days, a `(pseudonym_hash, driver_pseudonym_hash)` pair contributes at most **1 weighted vote** per `query_cluster_id`; later pair trips carry `initial_weight = 0` (recorded for audit).
2. **Per-Rider Cluster Cap (concept paper §12.1):** at most **1 counted vote per rider per query cluster per week**, and at most **3 counted votes per rider per cluster per 90-day window**. Excess votes are logged with weight 0.
3. **Driver Cohort Cap:** no driver may exceed **25 %** of the cluster's unweighted vote count
   $$\frac{\text{max\_driver\_trips}}{\text{total\_vote\_count}} \le 0.25$$
   (denominator is the cluster's total vote count, not distinct riders).
4. **Burst Quarantine:** if > 60 % of a cluster's lifetime votes arrive within 48 h `[ESTIMATE]`, hold `candidate` status and require 2 additional weeks of sustained traffic.

---

## 4. Spatial Pre-Clustering, Hex Boundary Consolidation & $k=1$ Ring Aggregation

### 4.1 The Boundary Splitting Problem
H3 res-10 cells (~15,047 m² average `[UNVERIFIED — H3 official table, 23.8° N]`) split gate-level drop-offs: 55 % / 45 % across two cells fails every share gate even though 100 % of riders used one curb.

### 4.2 DBSCAN Consolidation (metric-corrected)
Drop-offs for a query cluster are clustered at 30 m before gate evaluation. Degrees are anisotropic at Dhaka's latitude — cluster in a metric CRS:

```sql
ST_ClusterDBSCAN(ST_Transform(dropoff_geom, 32646), eps := 30, minpoints := 1)
  OVER (PARTITION BY query_cluster_id) AS spatial_cluster_id   -- EPSG:32646 (UTM 46N)
```
- Cluster radius 30 m; representative cell = cell of the medoid/centroid drop-off.
- Distinct candidates compete only when separated by > 75 m `[ESTIMATE]`.

### 4.3 $k=1$ Neighbor Ring Aggregation (F-009-4)
Sprawling landmarks (airports, universities, hospitals, stadiums) span adjacent cells. Candidate evaluation may expand its **accepted cell set** to the $k=1$ ring:

$$\text{CellSet}(C) = \{\text{anchor}\} \cup \mathrm{gridDisk}(\text{anchor}, 1)$$

- Trigger: candidate's spatial extent > 150 m `[ESTIMATE]` or touches > 2 res-10 cells.
- Computed **dynamically at evaluation time** in the application layer (`h3-js` `gridDisk`, passed to SQL as a cell array) — raw ledger rows are **never mutated**, and no Postgres H3 extension is required.
- Gate 4 aggregates the candidate's votes across `CellSet(C)` (post-DBSCAN consolidation); Gate 5's anchor-cell margin uses the per-cell shares of `dpmaps.v_active_cluster_evidence` (§5.5).

---

## 5. The 6 Minimum Publication Thresholds

All weights use Stage 003's read-time decay: $w_i = \texttt{dpmaps.calculate\_decayed\_weight}(\text{initial\_weight}_i, t_i, T_{\text{cutoff}})$, $\lambda = \ln(2)/45 \approx 0.0154033/\text{day}$. Evidence basis: `dpmaps.v_active_cluster_evidence` (anchor-key dedup, invalidations excluded, **no `HAVING COUNT >= 15` filter** — runner-up cells are preserved by design).

```
 Gate 1: distinct_riders   >= 15   (unweighted, anchor key)
 Gate 2: distinct_drivers  >= 5    (+ driver cohort cap <= 25%)
 Gate 3: active_weeks      >= 3    (distinct ISO weeks)
 Gate 4: vote share        >= 0.70 (decayed weights over query cluster total)
 Gate 5: cell margin       >= 0.20 (anchor cell vs best runner-up cell, view basis)
 Gate 6: Wilson W_lower    >  0.50 (95% CI, Kish n_eff)
```

### 5.1–5.3 Diversity & Temporal Gates
Gate 1 counts distinct `pseudonym_hash` under the active dedup key (Stage 003 `active_dedup_key`); Gate 2 counts distinct `driver_pseudonym_hash`; Gate 3 counts distinct ISO weeks (`IYYY-IW`) — all unweighted.

### 5.4 Gate 4: Vote Share Dominance ($\hat{s}_1 \ge 0.70$)
$$\hat{s}_1 = \frac{\sum_{i \in \text{CellSet}(C)} w_i}{W_{\text{total}}} \ge 0.70$$

### 5.5 Gate 5: Cell Margin of Victory ($s_1 - s_2 \ge 0.20$) — repaired (F-009-2)
Shares are the per-**cell** weighted shares of the query cluster from `dpmaps.v_active_cluster_evidence` (unfiltered):
$$s_1 = \frac{\texttt{sum\_weights}(\text{anchor cell})}{W_{\text{total}}}, \qquad s_2 = \max_{c \notin \text{CellSet}(C)} \frac{\texttt{sum\_weights}(c)}{W_{\text{total}}}, \qquad s_1 - s_2 \ge 0.20$$

**Theorem 1 (single-cell candidates — implied, never binds).** If all candidate votes lie in the anchor cell, every other cell's share sums to $1 - s_1$, so $s_2 \le 1 - s_1$ and
$$s_1 - s_2 \ \ge\ 2s_1 - 1 \ \ge\ 0.40 \ >\ 0.20 \quad \text{whenever } s_1 \ge 0.70 .$$
Thus on a single-cell basis Gate 5 is mathematically implied by Gate 4 (the AGENTS.md first-pass finding "Gate 5 can never bind" holds here). It is retained as a hard invariant that becomes binding if the admin lowers the Gate 4 threshold below 0.60.

**Theorem 2 (consolidated multi-cell candidates — binding).** Once DBSCAN/$k$=1 consolidation lets a candidate span cells, Gate 4's share is the cluster share while Gate 5 measures the **anchor cell against the best competing cell outside the candidate**. Counterexample: cells A 44 %, B 31 % (candidate cluster/ring), C 25 % (outside). Cluster share $= 75\%$ passes Gate 4; anchor margin $= 44 - 25 = 19$ points $< 20$ → **Gate 5 rejects**. Gate 5 therefore enforces spatial concentration: the published anchor cell must itself dominate any single rival cell — exactly the runner-up cells preserved in the unfiltered view.

Ambiguity rule: when Gate 5 fails on genuinely competing destinations ("Bashundhara Gate 1" vs "Gate 2"), **publish nothing** for that cluster and fall back to vendor passthrough. dpMaps never guesses between ambiguous locations.

### 5.6 Gate 6: Wilson Score with Kish $n_{\text{eff}}$ — verified threshold (F-009-3)

#### 5.6.1 Kish Effective Sample Size
$$n_{\text{eff}} = \frac{\left(\sum_i w_i\right)^2}{\sum_i w_i^2} = \frac{W_{\text{total}}^2}{S_{\text{total}}}$$

#### 5.6.2 Wilson Score (95 %, $z = 1.96$, two-sided — formulation of record)
$$W_{\text{lower}} = \frac{\hat{p} + \frac{z^2}{2n_{\text{eff}}} - z\sqrt{\frac{\hat{p}(1-\hat{p})}{n_{\text{eff}}} + \frac{z^2}{4n_{\text{eff}}^2}}}{1 + \frac{z^2}{n_{\text{eff}}}} \ >\ 0.50$$

#### 5.6.3 Theorem (Gate 6 boundary at $p = 0.70$) — proof
Substituting $\hat{p} = 0.70$, $z = 1.96$ ($z^2 = 3.8416$):

| $n_{\text{eff}}$ | $\frac{z^2}{n}$ | center $\frac{\hat p + z^2/2n}{1+z^2/n}$ | $z\sqrt{\cdot}$ | margin $/ (1{+}z^2/n)$ | $W_{\text{lower}}$ | Gate 6 |
|---:|---:|---:|---:|---:|---:|:---:|
| 15 | 0.25611 | 0.65922 | 0.26491 | 0.21090 | **0.4483** | REJECT |
| 23 | 0.16703 | 0.67138 | 0.20506 | 0.17571 | **0.4957** | REJECT |
| 24 | 0.16007 | 0.67240 | 0.20005 | 0.17245 | **0.49996** | REJECT (≤ 0.5) |
| 25 | 0.15366 | 0.67336 | 0.19538 | 0.16935 | **0.5040** | **PASS** |

$W_{\text{lower}}(0.70, n)$ is strictly increasing in $n$, so:

> **Theorem.** $W_{\text{lower}}(0.70) > 0.5 \iff n_{\text{eff}} \ge 25$ (integer). At $n_{\text{eff}} = 23$ the required share rises to $\hat p \approx 0.7045$; at $n_{\text{eff}} = 24$ it is $\approx 0.7001$.

**The "≥ 23" claim is rejected** — it fails at $n = 23$ ($0.4957$) and $n = 24$ ($0.49996$). Continuity-corrected Wilson variants are strictly wider and need still larger $n_{\text{eff}}$, so no standard variant rescues it. The gate implements the formula numerically per candidate (no hard-coded $n$); $n_{\text{eff}} \ge 25$ is the analytic boundary at exactly 70 % share, matching TC-009-09.

#### 5.6.4 Boundary Behavior (recomputed values)

| Scenario | $n_{\text{eff}}$ | $\hat p$ | $W_{\text{lower}}$ | Outcome |
|---|---:|---:|---:|---|
| Minimal sample at Gate 4 bound | 15 | 0.70 | 0.4483 | REJECT (Gate 6) |
| Strong consensus, minimal sample | 15 | 0.85 | **0.6023** | PASS gates 4/6 |
| Borderline at high dominance | 25 | 0.70 | **0.5040** | PASS (gate 6 boundary) |
| Large sample, weak lead | 100 | 0.55 | 0.4524 | REJECT (4, 5, 6) |
| Decayed stale evidence | 8.2 | 0.90 | **0.5603** | REJECT (Gate 1) |

*(Prior revisions listed 0.604 and 0.573 for rows 2 and 5; recomputation gives 0.6023 and 0.5603 — corrected above.)*

---

## 6. Zero-Write-Amplification Query-Time Decay

`dpmaps.trip_evidence_ledger` is append-only; decay is computed at read time by `dpmaps.calculate_decayed_weight(initial_weight, created_at, as_of)` (Stage 003 §6.2, $\lambda = 0.0154033$, rounds to 4 dp) — **never** inline `EXP()` drift and never row mutation. Candidate extraction reads `dpmaps.v_active_cluster_evidence` / `dpmaps.mv_cluster_evidence_stats`; DBSCAN consolidation runs over raw rows joined exactly as the view does (ledger ⋈ `ledger_pseudonyms` ⋈ `active_dedup_key`, invalidations excluded).

The monthly publication run executes in the maintenance window (21:00–23:00 UTC) on read-only pooled connections.

---

## 7. The Two-Cycle Challenger Rule (F-009-5)

Oscillation threat: 52 % vs 48 % neighbors alternating monthly destroy caches and bookmarks.

1. **Cycle $M$:** challenger cluster $C$ passes all 6 gates and $W_{\text{lower}}(C) > W_{\text{lower}}(I)$. Record `provisional_challenger` (Stage 003 Rev 2.4 table). Incumbent $I$ stays live.
2. **Cycle $M+1$ (must be the immediately following monthly cycle):** $C$ **again** passes all 6 gates with $W_{\text{lower}}(C) > W_{\text{lower}}(I)$ — **then and only then** $C$ supersedes $I$.

**Demote, never delete (F-009-5):** unseated incumbents transition to `demoted` (or `retired` when permanently closed) per `dpmaps.poi_status_enum`; `superseded_by` points to the winner; the UUID remains valid for bookmarks, receipts, and history forever. Emergency privacy takedowns use `suppressed` (Stage 011).

```
candidate ──(6 gates in M)──► provisional ──(6 gates again in M+1)──► active
   ▲                                   │                                │
   └────────(fails M+1)────────────────┘          (unseated/decayed) ──► demoted/retired
                                                    (takedown) ────────► suppressed
```

---

## 8. Stable Entity Architecture & Permanent UUIDv4 (F-009-1)

1. **Immutable random PK:** `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` — minted **once**, permanent across renames and geometry refinements. Never `UUIDv5(name/h3)`; never any cell- or name-derived identifier.
2. **No cell-derived names:** the worker does **not** write `"Learned Place <cell>"`. A new entity is inserted with `lifecycle_status = 'candidate'` and a provisional `canonical_name` = the **sanitized canonical query** from the Stage 007 pipeline (Stage 010 Tier 3 input), privacy-scrubbed per Stage 011 §3. Stage 010's authority hierarchy owns all display-name upgrades. `chk_poi_name_exists` (Stage 003) requires one non-null name; the provisional canonical query satisfies it without inventing identity from geometry.
3. **Lineage:** geometry/metadata changes archive prior state in `dpmaps.poi_versions`; `superseded_by` (exact column name) links replaced entities.
4. **Canonical payload hash:**
   $$\text{leaf\_hash} = \mathrm{SHA256}(\texttt{id} \parallel \texttt{h3\_res10} \parallel \texttt{ST\_AsBinary(geom)} \parallel \texttt{publication\_cycle})$$

---

## 9. Implementation: Winner Selection Worker (conformant)

```typescript
// workers/winnerSelectionWorker.ts
import { Pool, PoolClient } from 'pg';
import { gridDisk } from 'h3-js';           // k=1 ring at evaluation time (F-009-4)
import { createHash, createHmac } from 'crypto';

export function computeKishWilsonLowerBound(
  weightedVotes: number, totalWeightedVotes: number, totalSumSqWeights: number, z = 1.96
): { w_lower: number; n_eff: number; p: number } {
  if (totalWeightedVotes <= 0 || totalSumSqWeights <= 0) return { w_lower: 0, n_eff: 0, p: 0 };
  const n_eff = Math.pow(totalWeightedVotes, 2) / totalSumSqWeights;
  const p = weightedVotes / totalWeightedVotes;
  if (n_eff < 1) return { w_lower: 0, n_eff, p };
  const zSq = z * z;
  const denominator = 1 + zSq / n_eff;
  const center = p + zSq / (2 * n_eff);
  const spread = z * Math.sqrt(Math.max(0, p * (1 - p) / n_eff + zSq / (4 * n_eff * n_eff)));
  const w_lower = (center - spread) / denominator;
  return { w_lower: Math.max(0, Math.min(1, w_lower)), n_eff, p };
}

export function evaluateCandidateGates(
  leader: { distinct_riders: number; distinct_drivers: number; active_weeks: number;
            cluster_weighted_votes: number; total_query_weighted_votes: number;
            anchor_cell_share: number; total_query_sum_w_sq: number;
            max_driver_share: number },
  runnerUpCellShare: number | null           // from v_active_cluster_evidence (unfiltered)
): { passed: boolean; gate_failures: string[]; w_lower: number; n_eff: number; margin: number; vote_share: number } {
  const failures: string[] = [];
  if (leader.distinct_riders < 15) failures.push(`Gate 1: riders ${leader.distinct_riders} < 15`);
  if (leader.distinct_drivers < 5) failures.push(`Gate 2: drivers ${leader.distinct_drivers} < 5`);
  if (leader.max_driver_share > 0.25) failures.push(`Gate 2 cap: driver share ${(leader.max_driver_share * 100).toFixed(1)}% > 25%`);
  if (leader.active_weeks < 3) failures.push(`Gate 3: weeks ${leader.active_weeks} < 3`);

  const voteShare = leader.cluster_weighted_votes / leader.total_query_weighted_votes; // CellSet basis
  if (voteShare < 0.70) failures.push(`Gate 4: share ${(voteShare * 100).toFixed(2)}% < 70%`);

  // Gate 5 (F-009-2): anchor CELL vs best runner-up CELL from v_active_cluster_evidence.
  // Single-cell: implied by Gate 4 (>= 0.40). Multi-cell: binding (see plan §5.5).
  const margin = runnerUpCellShare === null ? 1 : leader.anchor_cell_share - runnerUpCellShare;
  if (margin < 0.20) failures.push(`Gate 5: cell margin ${(margin * 100).toFixed(2)} < 20 pts`);

  const { w_lower, n_eff } = computeKishWilsonLowerBound(
    leader.cluster_weighted_votes, leader.total_query_weighted_votes, leader.total_query_sum_w_sq);
  if (w_lower <= 0.5) failures.push(`Gate 6: W_lower ${w_lower.toFixed(4)} <= 0.5 (n_eff ${n_eff.toFixed(1)})`);

  return { passed: failures.length === 0, gate_failures: failures,
           w_lower: +w_lower.toFixed(4), n_eff: +n_eff.toFixed(2),
           margin: +margin.toFixed(4), vote_share: +voteShare.toFixed(4) };
}

export async function runWinnerSelectionCycle(
  pool: Pool, publicationCycle: string, auditSecret: string
): Promise<{ processed: number; promoted: number; rejected: number }> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    // Candidates from the canonical view (anchor-key dedup; runner-ups preserved).
    const { rows: cellRows } = await client.query(
      `SELECT * FROM dpmaps.v_active_cluster_evidence ORDER BY query_cluster_id, sum_weights DESC`);
    // DBSCAN consolidation + ring expansion computed in the worker (plan §4):
    // clusters of raw rows (same anchor-key join) → CellSet = anchor ∪ gridDisk(anchor,1) when sprawling.

    // Per query cluster: leader = consolidated candidate; runnerUpCellShare = highest
    // share among cells outside the leader's CellSet (0 if none); evaluateCandidateGates(...).

    // Publication decision:
    //  - no incumbent            → INSERT public_pois (lifecycle 'candidate' → promoted per §7
    //    only after the second consecutive win if an incumbent exists; new places publish
    //    on first full pass) with:
    //      id            DEFAULT gen_random_uuid()          -- minted once (F-009-1)
    //      canonical_name = sanitized canonical query        -- Stage 010 tier-3 input; NEVER cell strings
    //      lifecycle_status = 'active', point_type per evidence, h3_res9/h3_res10 of anchor,
    //      canonical_payload_hash = SHA256(id||h3_res10||geom||cycle), audit_hmac, provenance JSONB
    //  - incumbent same anchor   → UPDATE confidence/metrics only
    //  - incumbent different     → challenger protocol (§7) via dpmaps.provisional_challengers:
    //      cycle M:   INSERT provisional row (status 'active')
    //      cycle M+1: INSERT new POI, old row → lifecycle 'demoted', superseded_by = new id
    //                 (never DELETE; column is superseded_by per Stage 003)

    await client.query('COMMIT');
    return { processed: 0, promoted: 0, rejected: 0 }; // counters filled per-cluster
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

---

## 10. Unit Testing Matrix & Mathematical Boundary Verification

| Test Case | Scenario | Expected | Rationale |
|---|---|:---:|---|
| TC-009-01 | `distinct_riders = 14` | REJECT | Gate 1 strict boundary |
| TC-009-02 | `distinct_drivers = 4` | REJECT | Gate 2 strict boundary |
| TC-009-03 | `active_weeks = 2`, 100 trips / 14 d | REJECT | Gate 3 viral suppression |
| TC-009-04 | share 69.9 % | REJECT | Gate 4 boundary |
| TC-009-05 | leader 72 % + runner-up 54 % | REJECT | Integrity: shares > 1 |
| TC-009-06 | 72 % / 28 % | PASS 4 & 5 | margin 44 pts |
| TC-009-07 | 55 % / 45 % | REJECT | Gate 5 ambiguity (10 pts) |
| TC-009-08 | $n_{\text{eff}} = 15$, $p = 0.70$ | REJECT | $W_{\text{lower}} = 0.4483$ |
| **TC-009-09** | $n_{\text{eff}} = 25$, $p = 0.70$ | **PASS** | $W_{\text{lower}} = 0.5040$ — Gate 6 boundary |
| **TC-009-09b** | $n_{\text{eff}} = 23$, $p = 0.70$ | **REJECT** | $W_{\text{lower}} = 0.4957$ — the "≥ 23" claim fails (F-009-3) |
| TC-009-09c | $n_{\text{eff}} = 24$, $p = 0.70$ | REJECT | $W_{\text{lower}} = 0.49996 \le 0.5$ |
| TC-009-10 | driver = 30 % of votes | REJECT | Gate 2 cohort cap (correct denominator) |
| TC-009-11 | challenger wins cycle $M$ only | PROVISIONAL | two-cycle rule |
| TC-009-12 | challenger wins $M$ and $M{+}1$ | SUPERSEDE | incumbent `demoted`, `superseded_by` set, UUID preserved |
| TC-009-13 | 55/45 split across res-10 boundary | PASS | DBSCAN consolidation |
| **TC-009-14** | cells 44/31 (candidate) vs 25 (rival); cluster share 75 % | **REJECT (Gate 5)** | binding margin on multi-cell candidate (F-009-2 theorem 2) |
| **TC-009-15** | sprawling campus across 3 cells, anchor 62 %, rival 15 % | PASS | $k=1$ ring aggregation (F-009-4) |
| TC-009-16 | rider 4th vote in same cluster/90 d | WEIGHT 0 | per-rider cluster cap |

---

## 11. Operational Controls, Release Manifests & Emergency Takedown

### 11.1 Immutable Release Manifest
Each cycle writes `dpmaps.releases` (release_id, cutoff, anchor key id, normalizer/ruleset versions + hash, counts, merkle_root, TSA receipt) and `dpmaps.release_pois` rows. Releases are immutable and versioned; rollback is a one-step pointer switch.

### 11.2 Emergency Suppression & Rollback
1. Suppression (Stage 011) writes `dpmaps.suppressions` and the Redis Set `dpmaps:suppression:active_place_ids` (**Redis Set / sliding-window counter — not a Bloom filter**); MeiliSearch eviction across `first_party_pois` and `osm_pois` completes in < 60 s `[ESTIMATE]`, well inside the Tier 1 < 1 h SLA.
2. One-step rollback: `npm run dpmaps:release -- --rollback-to pub-2026-10-01` — pointers revert; the suppression set is **never** cleared by rollback.

---

## 12. Deliverables & Definition of Done

- [ ] Wilson/Kish math verified by test suite including TC-009-09b/09c boundary cases; documented theorem ($n_{\text{eff}} \ge 25$ at $p = 0.70$) matches the implementation's numeric evaluation.
- [ ] Gate 5 evaluated on `v_active_cluster_evidence` cell shares; TC-009-14 proves the multi-cell binding behavior; theorem notes in code comments.
- [ ] DBSCAN consolidation metric-corrected (EPSG:32646); $k=1$ ring via `h3-js gridDisk` with zero ledger mutations (TC-009-15).
- [ ] UUIDv4 permanence tests: rename/geometry change preserves `id`; no cell-derived strings in any name or identifier field.
- [ ] Two-cycle challenger protocol with demote-not-delete verified (TC-009-11/12).
- [ ] Cap enforcement (pairwise, per-rider 1/week ≤ 3/90 d, driver 25 %, burst quarantine) verified in ingestion tests.
- [ ] `trip_hash = HMAC-SHA256(trip_id, IngestionSalt)`; 135-day key schedule via `active_dedup_key`; decay exclusively via `dpmaps.calculate_decayed_weight`.
- [ ] Clean-room: zero vendor-derived strings/IDs/coordinates in the ledger; suppression checks use Redis Set semantics.
- [ ] **Stage 002 Legal Gate:** no learning ingestion before Items 3, 7, 14, 15, 16, 17 sign-off.

---

## 13. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Three-layer engine, UUIDv4 pivot, DBSCAN consolidation, 6 gates, Kish/Wilson, two-cycle challenger, anti-collusion. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-2 audit) | **Gate Logic, Identity & Verified Thresholds:**<br>1. **Gate 6 theorem (F-009-3):** proved $W_{\text{lower}}(0.70) > 0.5 \iff n_{\text{eff}} \ge 25$; the "≥ 23" claim rejected (0.4957 at 23; 0.49996 at 24); boundary table recomputed (0.6023 / 0.5603 corrections); TC-009-09b/09c added.<br>2. **Gate 5 repair (F-009-2):** evaluated against runner-up cells in `dpmaps.v_active_cluster_evidence` (unfiltered); proved single-cell implication (never binds under Gate 4) and multi-cell binding (TC-009-14).<br>3. **Identity residue removal (F-009-1):** cell-derived display names eliminated (provisional name = sanitized canonical query, Stage 010 owns display names); `superseded_by` and `poi_status_enum` values conformed.<br>4. **$k=1$ ring aggregation (F-009-4):** dynamic `gridDisk` evaluation, no ledger mutation, no Postgres H3 extension.<br>5. **Two-cycle rule bound (F-009-5):** consecutive monthly cycles; demote (`demoted`/`retired`) never delete; `superseded_by` lineage.<br>6. **Conformance bundle (F-009-6):** `trip_hash = HMAC(trip_id, IngestionSalt)`; 135-day schedule via `active_dedup_key`; `calculate_decayed_weight` replaces inline `EXP`; driver-cap denominator fixed to total votes; per-rider cluster caps (1/week, ≤ 3/90 d) added; DBSCAN metric CRS; Redis Set wording; missing-object adoption brief (Part F of batch-2 audit). |
