/**
 * winnerSelector.ts — Stage 009 §§2/4/7/8 winner selection engine.
 *
 * Three-layer learning architecture (§2):
 *   Layer 1 Relevance — what riders typed (query cluster, phonetic keys).
 *   Layer 2 Identity  — where vehicles stop (anchor cell, CellSet, point type).
 *   Layer 3 Display Name — Stage 010's 4-tier hierarchy ONLY. Trip votes
 *     never alone decide names: a new entity's provisional canonical_name
 *     is the sanitized canonical query (Stage 010 Tier-3 input), NEVER a
 *     cell-derived string ("Learned Place <cell>" is forbidden).
 *
 * Identity (F-009-1): place IDs are minted ONCE via crypto.randomUUID()
 * (UUIDv4) — never derived from name or cell. Renames and geometry
 * refinements never change the ID; lineage lives in poi_versions +
 * superseded_by. Demote, never delete (F-009-5).
 *
 * Spatial consolidation (F-009-4): DBSCAN runs in the worker over raw rows
 * (metric CRS EPSG:32646, eps 30 m — production PostGIS; this module takes
 * consolidated extents as input). The k=1 ring CellSet = anchor ∪
 * gridDisk(anchor, 1) is computed dynamically at evaluation time with an
 * INJECTED gridDisk (production: h3-js) — raw ledger rows are never
 * mutated and no Postgres H3 extension is required.
 *
 * Two-cycle challenger rule (§7): win in cycle M → provisional; win again
 * in the immediately following cycle M+1 → supersede (incumbent demoted,
 * superseded_by set). Fail M+1 → back to candidate.
 *
 * Zero ledger/DB dependencies: pure decision functions + injectable
 * gridDisk. Production worker (winnerSelectionWorker, Phase 2 infra) feeds
 * view aggregates and executes the returned decisions in one transaction.
 */

import { randomUUID, createHash } from 'node:crypto';

export const RING_K = 1;

/** Lifecycle states of record (dpmaps.poi_status_enum subset). */
export type PoiLifecycle = 'candidate' | 'active' | 'demoted' | 'retired' | 'suppressed';

/** Layer 1: relevance — what riders typed. */
export interface Layer1Relevance {
  queryClusterId: string;
  normalizedQuery: string;
  phoneticKey: string;
}

/** Layer 2: identity — where vehicles stop. */
export interface Layer2Identity {
  anchorCell: string;
  centroid: { lat: number; lng: number };
  pointType: string;
}

/** A consolidated publication candidate (post-DBSCAN, pre-gate). */
export interface Candidate {
  relevance: Layer1Relevance;
  identity: Layer2Identity;
}

/** Injected H3 ring expansion (production: h3-js gridDisk). */
export type GridDiskFn = (cell: string, k: number) => string[];

/**
 * Mint a permanent place ID: random UUIDv4, minted once. The function
 * takes no inputs — derivation from name or cell is impossible by
 * construction (audit asserts arity + format + uniqueness).
 */
export function mintPlaceId(): string {
  return randomUUID();
}

/** UUIDv4 shape check (8-4-4-4-12, version nibble 4). */
export function isUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Dynamic k=1 ring CellSet at evaluation time (F-009-4): the anchor plus
 * its gridDisk(anchor, 1) neighbors. Pure — inputs never mutated.
 */
export function cellSetFor(anchorCell: string, gridDisk: GridDiskFn): Set<string> {
  return new Set([anchorCell, ...gridDisk(anchorCell, RING_K)]);
}

/**
 * Provisional-name guard (F-009-1): the Tier-3 provisional name must be
 * the sanitized canonical query — never a cell-derived string. Rejects
 * "Learned Place <cell>" patterns, raw cell IDs, and hex-blob names.
 */
export function assertProvisionalName(name: string, anchorCell: string): void {
  if (!name || !name.trim()) throw new Error('assertProvisionalName: empty provisional name');
  const n = name.trim();
  if (/^learned place\b/i.test(n)) {
    throw new Error(`assertProvisionalName: cell-derived name refused ('${n}')`);
  }
  if (anchorCell && n.includes(anchorCell)) {
    throw new Error('assertProvisionalName: name contains anchor cell id');
  }
  if (/^0x[0-9a-f]+$/i.test(n.replace(/\s+/g, '')) && n.replace(/\s+/g, '').length > 12) {
    throw new Error('assertProvisionalName: hex-blob name refused');
  }
}

/**
 * Canonical payload leaf hash (§8.4):
 * leaf_hash = SHA256(id || h3_res10 || ST_AsBinary(geom) || publication_cycle).
 * geomWkbHex is the hex-encoded WKB (production: ST_AsBinary(...)).
 */
export function leafHash(
  id: string,
  h3Res10: string,
  geomWkbHex: string,
  publicationCycle: string,
): string {
  return createHash('sha256').update(`${id}||${h3Res10}||${geomWkbHex}||${publicationCycle}`).digest('hex');
}

export interface ChallengerState {
  challengerClusterId: string;
  incumbentPoiId: string;
  /** Cycle ID (e.g. 'pub-2026-11') in which M was won. Null = no provisional. */
  provisionalCycle: string | null;
}

export type ChallengerDecision =
  | { outcome: 'provisional'; state: ChallengerState }
  | { outcome: 'supersede'; state: ChallengerState; demoteIncumbentTo: PoiLifecycle }
  | { outcome: 'incumbent_holds'; state: ChallengerState }
  | { outcome: 'rejected'; state: ChallengerState };

/**
 * Two-cycle challenger protocol (§7). wonM / wonM1 are the gate verdicts
 * for THIS cycle given the state's provisionalCycle:
 *  - no provisional + win  → 'provisional' (cycle M recorded)
 *  - provisional from an EARLIER cycle + win → 'supersede' (demote incumbent)
 *  - loss → 'incumbent_holds' if a provisional existed (cleared),
 *    else 'rejected'.
 */
export function evaluateChallenger(
  state: ChallengerState,
  thisCycle: string,
  wonThisCycle: boolean,
): ChallengerDecision {
  if (wonThisCycle && (state.provisionalCycle === null || state.provisionalCycle === thisCycle)) {
    // Fresh win → provisional; same-cycle re-win → stays provisional (idempotent).
    return {
      outcome: 'provisional',
      state: { ...state, provisionalCycle: thisCycle },
    };
  }
  if (wonThisCycle && state.provisionalCycle !== null && state.provisionalCycle !== thisCycle) {
    return {
      outcome: 'supersede',
      state,
      demoteIncumbentTo: 'demoted',
    };
  }
  if (!wonThisCycle && state.provisionalCycle !== null) {
    return { outcome: 'incumbent_holds', state: { ...state, provisionalCycle: null } };
  }
  return { outcome: 'rejected', state };
}

export interface DemotionRecord {
  poi_id: string;
  previous_status: PoiLifecycle;
  new_status: Extract<PoiLifecycle, 'demoted' | 'retired'>;
  superseded_by: string;
}

/**
 * Demote, never delete (F-009-5): unseated incumbents transition status
 * with superseded_by pointing at the winner. The UUID stays valid for
 * bookmarks, receipts, and history forever. There is deliberately NO
 * delete path in this module.
 */
export function demoteIncumbent(
  incumbentPoiId: string,
  winnerPoiId: string,
  retired: boolean = false,
): DemotionRecord {
  if (!isUuidV4(incumbentPoiId) || !isUuidV4(winnerPoiId)) {
    throw new Error('demoteIncumbent: both IDs must be UUIDv4');
  }
  if (incumbentPoiId === winnerPoiId) {
    throw new Error('demoteIncumbent: incumbent and winner must differ');
  }
  return {
    poi_id: incumbentPoiId,
    previous_status: 'active',
    new_status: retired ? 'retired' : 'demoted',
    superseded_by: winnerPoiId,
  };
}

export interface PoiVersionRecord {
  poi_id: string;
  superseded_by: string | null;
  change: string;
}

/** Lineage archive entry for dpmaps.poi_versions. */
export function buildVersionRecord(
  poiId: string,
  change: string,
  supersededBy: string | null = null,
): PoiVersionRecord {
  return { poi_id: poiId, superseded_by: supersededBy, change };
}
