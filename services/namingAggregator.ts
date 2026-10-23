/**
 * namingAggregator.ts — Stage 010 §6 aggregation worker (lineage-safe).
 *
 * Monthly cadence, same maintenance window as Stage 009. For each candidate
 * POI: aggregate staged labels by normalized_text (distinct pseudonym_hash);
 * quorum ≥ 5 distinct riders [ESTIMATE]; consensus ≥ 60% [ESTIMATE].
 * Sanitize the winner (§5). NEVER promote an individual label.
 *
 * §6.1 unindexed-cluster path (F-010-6): rows with poi_id NULL aggregate by
 * (h3_res10, normalized_text) with the same quorum/consensus. A passing
 * result SEEDS a Stage 009 candidate (convergent name evidence attached to
 * the cell) — it never writes a display name and never mints a place by
 * itself; Stage 009's gates decide existence.
 *
 * Lineage (F-010-4, TC-010-13): version row FIRST, then the name UPDATE;
 * the UUID never changes. The bilingual gate (§3.1) is enforced in code
 * before any publish — the DB CHECK stays authoritative.
 *
 * Divergence note: the plan §6 lineage INSERT lists only
 * (poi_id, version_number, canonical_name, bangla_name,
 * canonical_payload_hash, audit_hmac, release_id). The verified Stage 003
 * schema declares poi_versions.category, lifecycle_status, geom and
 * release_id NOT NULL with no defaults — the abridged INSERT would violate
 * them. buildLineageFirstUpdateSql() returns the plan's statement verbatim
 * for audit traceability AND the conformant full-row carry-forward the
 * worker must actually execute.
 */

import { sanitizeAndFormatDisplayName } from '../utils-server/namingSanitizer';
import { canPublishAsActive } from './bilingualEngine';
import { assertConsensusPromotion, assertTier4NeverPersists, TIER_2_PROVENANCE_TAG } from './namingHierarchy';

/**
 * Admin-configurable thresholds [ESTIMATE — replay on real trip data
 * before enforcement]. Centralized here so tuning never touches logic.
 */
export const NAMING_THRESHOLDS = {
  quorumRiders: 5,
  consensusShare: 0.6,
  aliasRunnerUpShare: 0.2,
  samplingRateCap: 0.1,
} as const;

export interface StagedLabelRow {
  poi_id: string | null;
  h3_res10: string;
  normalized_text: string;
  pseudonym_hash: string;
  publication_cycle: string;
}

export interface ConsensusOutcome {
  winner: string;
  winnerDistinctRiders: number;
  totalDistinctRiders: number;
  share: number;
  runnerUpAliases: string[];
  promoted: boolean;
  reason: 'quorum_consensus_met' | 'no_quorum' | 'no_consensus' | 'sanitizer_reject' | 'bilingual_gate_block';
  sanitizedCanonical?: string;
  sanitizedBangla?: string;
}

/** Group rows by key → distinct pseudonym sets. */
function groupDistinct(
  rows: StagedLabelRow[],
  keyOf: (r: StagedLabelRow) => string
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = keyOf(r);
    let s = groups.get(k);
    if (!s) {
      s = new Set();
      groups.set(k, s);
    }
    s.add(r.pseudonym_hash.toLowerCase());
  }
  return groups;
}

/**
 * Core quorum/consensus evaluation shared by the indexed and unindexed
 * paths. `totalDistinct` counts distinct riders across ALL variants.
 */
export function evaluateConsensus(
  rows: StagedLabelRow[],
  keyOf: (r: StagedLabelRow) => string,
  thresholds = NAMING_THRESHOLDS
): ConsensusOutcome {
  const groups = groupDistinct(rows, keyOf);
  const allRiders = new Set(rows.map((r) => r.pseudonym_hash.toLowerCase()));
  const totalDistinct = allRiders.size;

  let winner = '';
  let winnerN = 0;
  for (const [text, riders] of groups) {
    if (riders.size > winnerN) {
      winnerN = riders.size;
      winner = text;
    }
  }
  if (winnerN < thresholds.quorumRiders || totalDistinct === 0) {
    return {
      winner, winnerDistinctRiders: winnerN, totalDistinctRiders: totalDistinct,
      share: totalDistinct === 0 ? 0 : winnerN / totalDistinct,
      runnerUpAliases: [], promoted: false, reason: 'no_quorum',
    };
  }
  const share = winnerN / totalDistinct;
  if (share < thresholds.consensusShare) {
    return {
      winner, winnerDistinctRiders: winnerN, totalDistinctRiders: totalDistinct,
      share, runnerUpAliases: [], promoted: false, reason: 'no_consensus',
    };
  }
  const runnerUps = [...groups.entries()]
    .filter(([text]) => text !== winner)
    .filter(([, riders]) => riders.size / totalDistinct >= thresholds.aliasRunnerUpShare)
    .map(([text]) => text);

  // Consensus proof is real (F-010-3: never an individual label).
  assertConsensusPromotion({ distinctRiders: winnerN, share });

  const s = sanitizeAndFormatDisplayName(winner);
  if (!s.valid) {
    return {
      winner, winnerDistinctRiders: winnerN, totalDistinctRiders: totalDistinct,
      share, runnerUpAliases: [], promoted: false, reason: 'sanitizer_reject',
    };
  }
  // Tier 4 never persists — the winner came from staged rider labels, so
  // this is defense-in-depth at the promotion boundary (TC-010-15).
  assertTier4NeverPersists(s.canonical_name, 'canonical_query');
  assertTier4NeverPersists(s.bangla_name, 'canonical_query');

  // Bilingual gate in code (TC-010-14): single-script winners do not publish.
  if (!canPublishAsActive({ canonical_name: s.canonical_name, bangla_name: s.bangla_name })) {
    return {
      winner, winnerDistinctRiders: winnerN, totalDistinctRiders: totalDistinct,
      share, runnerUpAliases: [], promoted: false, reason: 'bilingual_gate_block',
    };
  }
  return {
    winner, winnerDistinctRiders: winnerN, totalDistinctRiders: totalDistinct,
    share, runnerUpAliases: runnerUps, promoted: true, reason: 'quorum_consensus_met',
    sanitizedCanonical: s.canonical_name, sanitizedBangla: s.bangla_name,
  };
}

/** Indexed path: aggregate one POI's staged labels for a cycle. */
export function aggregateForPoi(
  poiId: string,
  rows: StagedLabelRow[],
  publicationCycle: string,
  thresholds = NAMING_THRESHOLDS
): ConsensusOutcome {
  const scoped = rows.filter((r) => r.poi_id === poiId && r.publication_cycle === publicationCycle);
  return evaluateConsensus(scoped, (r) => r.normalized_text, thresholds);
}

export interface UnindexedSeed {
  /** Always true: seeds attach convergent name evidence to the cell. */
  seedCandidateForStage009: boolean;
  h3_res10: string;
  nameEvidence: string;
  sanitizedCanonical?: string;
  sanitizedBangla?: string;
  writesDisplayName: false;
  mintsPlace: false;
}

/**
 * Unindexed path (F-010-6, X-10): (h3_res10, normalized_text) aggregation.
 * A passing result returns name evidence for Stage 009 — never a display
 * name, never a minted place.
 */
export function aggregateUnindexedCell(
  h3: string,
  rows: StagedLabelRow[],
  publicationCycle: string,
  thresholds = NAMING_THRESHOLDS
): (ConsensusOutcome & { seed: UnindexedSeed | null }) {
  const scoped = rows.filter(
    (r) => r.poi_id === null && r.h3_res10 === h3 && r.publication_cycle === publicationCycle
  );
  const outcome = evaluateConsensus(scoped, (r) => r.normalized_text, thresholds);
  if (!outcome.promoted) return { ...outcome, seed: null };
  return {
    ...outcome,
    seed: {
      seedCandidateForStage009: true,
      h3_res10: h3,
      nameEvidence: outcome.winner,
      sanitizedCanonical: outcome.sanitizedCanonical,
      sanitizedBangla: outcome.sanitizedBangla,
      writesDisplayName: false,
      mintsPlace: false,
    },
  };
}

/** UUID stability (F-010-4): renames never touch the place ID. */
export function assertIdUnchanged(beforeId: string, afterId: string): void {
  if (beforeId !== afterId) {
    throw new Error('STAGE010-LINEAGE: public_pois.id changed across a rename — forbidden');
  }
}

/**
 * Plan §6 step 3 statement VERBATIM (audit traceability). As documented
 * above, this abridged form violates the verified NOT NULL columns
 * (category, lifecycle_status, geom, release_id) — execute the conformant
 * variant below instead.
 */
export const PLAN_VERBATIM_LINEAGE_INSERT = `-- plan §6 verbatim (abridged — DO NOT EXECUTE as-is)
INSERT INTO dpmaps.poi_versions
   (poi_id, version_number, canonical_name, bangla_name,
    canonical_payload_hash, audit_hmac, release_id)
 SELECT $1,
        COALESCE((SELECT MAX(version_number) FROM dpmaps.poi_versions WHERE poi_id = $1), 0) + 1,
        p.canonical_name, p.bangla_name,
        encode(digest(p.id::text || COALESCE(p.canonical_name,'') || COALESCE(p.bangla_name,''), 'sha256'), 'hex'),
        $2, $3
   FROM dpmaps.public_pois p WHERE p.id = $1`;

/** Conformant lineage-first rename: full-row carry-forward. */
export function buildLineageFirstUpdateSql(): { versionInsert: string; nameUpdate: string } {
  return {
    versionInsert: [
      'INSERT INTO dpmaps.poi_versions',
      '  (poi_id, version_number, canonical_name, bangla_name, category,',
      '   lifecycle_status, geom, entrance_geom, parent_place_id, aliases,',
      '   canonical_payload_hash, audit_hmac, release_id)',
      'SELECT $1,',
      '       COALESCE((SELECT MAX(version_number) FROM dpmaps.poi_versions WHERE poi_id = $1), 0) + 1,',
      '       p.canonical_name, p.bangla_name, p.category,',
      "       p.lifecycle_status, p.geom, p.entrance_geom, p.parent_place_id,",
      "       COALESCE((SELECT jsonb_agg(a.alias_text) FROM dpmaps.poi_aliases a WHERE a.poi_id = p.id), '[]'::jsonb),",
      "       encode(digest(p.id::text || COALESCE(p.canonical_name,'') || COALESCE(p.bangla_name,''), 'sha256'), 'hex'),",
      '       $2, $3',
      'FROM dpmaps.public_pois p WHERE p.id = $1',
    ].join('\n'),
    nameUpdate: [
      'UPDATE dpmaps.public_pois SET',
      '  canonical_name = COALESCE($1, canonical_name),',
      '  bangla_name    = COALESCE($2, bangla_name),',
      "  provenance     = provenance || '{\"tier\": \"tier_2\", \"verified_by\": \"post_trip_consensus\"}'::jsonb,",
      '  updated_at     = NOW()',
      'WHERE id = $3',
    ].join('\n'),
  };
}

/** Runner-up alias row builder (uq (poi_id, alias_text) via ON CONFLICT). */
export function buildAliasUpsertSql(): string {
  return [
    'INSERT INTO dpmaps.poi_aliases (poi_id, alias_text, alias_type, source, status)',
    'VALUES ($1, $2, \'colloquial\', \'rider_typed\', \'active\')',
    'ON CONFLICT (poi_id, alias_text) DO NOTHING',
  ].join('\n');
}

export { TIER_2_PROVENANCE_TAG };
