/**
 * emergencySuppression.ts — Stage 011 section 5 Redis Set / sliding-window suppression.
 *
 * Active suppressions live in a Redis SET
 * (`dpmaps:suppression:active_place_ids`) — NEVER a Bloom filter (F-011-1:
 * a Bloom filter cannot expire or delete members without a full rebuild).
 * Point-deletion semantics (sRem) are required for restore (TC-011-11) and
 * for rollback persistence (TC-011-12).
 *
 * Eviction cascade (F-011-3):
 *   Tier A: Redis Set sAdd (under 5 ms engineering target [ESTIMATE])
 *   Tier B: dual-index MeiliSearch eviction, first_party_pois AND osm_pois
 *   Tier C: dpmaps.suppressions row (Stage 003 section 4.5 columns) +
 *            public_pois lifecycle_status = suppressed + provenance_events row
 *   Tier D: tile cache-tag purge (Cloudflare; platform wiring, OUT of scope)
 *   Tier E: OSRM entrance-snapping exclusion (Stage 004 track; OUT of scope)
 *
 * Zero infrastructure dependencies: Redis / Postgres / MeiliSearch arrive as
 * injected narrow interfaces (same pattern as Stages 004-010). The plan
 * section 6 code imports Pool from 'pg', RedisClientType from 'redis',
 * MeiliSearch from 'meilisearch', uuidv5 from 'uuid' and a logger — none of
 * which are repo dependencies — so this module takes interfaces + an
 * optional onError hook instead. SQL strings are exact Stage 003 shapes.
 */

import { createHash } from 'node:crypto';

export const REDIS_SUPPRESSION_SET = 'dpmaps:suppression:active_place_ids';
export const TAKEDOWN_PLACE_SET_PREFIX = 'dpmaps:takedown:place_reports:';
export const TAKEDOWN_USER_RATE_PREFIX = 'dpmaps:takedown:user_rate:';
export const DAY_SECONDS = 86400;

export const DUAL_SEARCH_INDEXES = ['first_party_pois', 'osm_pois'] as const;

/** Narrow injected Redis surface (Set + TTL-on-first-add counter). */
export interface SuppressionSetClient {
  sadd(key: string, member: string): Promise<number> | number;
  srem(key: string, member: string): Promise<number> | number;
  sismember(key: string, member: string): Promise<boolean> | boolean;
  scard(key: string): Promise<number> | number;
  incr(key: string): Promise<number> | number;
  expire(key: string, seconds: number): Promise<unknown> | unknown;
}

/** Narrow injected search-admin surface (Stage 008 dual indexes). */
export interface SuppressionSearchClient {
  deleteDocument(index: string, documentId: string): Promise<unknown> | unknown;
  restoreDocument?(index: string, document: Record<string, unknown>): Promise<unknown> | unknown;
}

/** Narrow injected Postgres surface. */
export interface SuppressionDbClient {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rowCount?: number | null; rows?: Array<Record<string, unknown>> }>;
}

export type SuppressionTargetType = 'poi_id' | 'osm_poi_id' | 'h3_cell' | 'name_pattern';
export type SuppressionReason =
  | 'court_order'
  | 'privacy_request'
  | 'security_sensitive'
  | 'copyright_claim'
  | 'sybil_attack';
export type SuppressionRequester = 'auto_hide' | 'user_report' | 'legal_counsel' | 'admin';
export type SuppressionSla = '1_hour' | '4_hours';

export interface EmergencySuppressionParams {
  target_type: SuppressionTargetType;
  target_value: string;
  reason: SuppressionReason;
  requester: SuppressionRequester;
  reported_at: Date;
  tier: SuppressionSla;
  actor_id: string;
  audit_note?: string;
}

export interface ServiceDeps {
  sets: SuppressionSetClient;
  search: SuppressionSearchClient;
  db: SuppressionDbClient;
  onError?: (info: { tier: string; err: unknown; indexName?: string }) => void;
}

/**
 * Deterministic namespace UUID (no uuid package in the repo): SHA-256 over
 * "namespace:type:value", formatted 8-4-4-4-12. Satisfies the
 * provenance_events.record_id NOT NULL for non-poi targets without
 * inventing identifiers (plan section 6 refinement, dependency-free).
 */
export function deterministicRecordId(namespace: string, targetType: string, targetValue: string): string {
  const hex = createHash('sha256').update(`${namespace}:${targetType}:${targetValue}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function provenanceEventHash(targetValue: string, reason: string, reportedAtIso: string): string {
  return createHash('sha256').update(`${targetValue}:${reason}:${reportedAtIso}`).digest('hex');
}

/** Stage 003 section 4.5 conformant suppressions INSERT (exact columns). */
export const SUPPRESSIONS_INSERT_SQL =
  'INSERT INTO dpmaps.suppressions\n' +
  '  (target_type, target_value, reason, is_auto_hidden, auto_hide_reason,\n' +
  '   reported_at, suppression_target_sla, applied_at, actor_id, audit_note)\n' +
  'VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)';

/** Active-suppression predicate (no active column exists — Stage 003). */
export const SUPPRESSION_ACTIVE_LOOKUP_SQL =
  'SELECT 1 FROM dpmaps.suppressions\n' +
  ' WHERE target_value = $1 AND applied_at IS NOT NULL\n' +
  '   AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1';

export const POI_SUPPRESS_UPDATE_SQL =
  "UPDATE dpmaps.public_pois SET lifecycle_status = 'suppressed', updated_at = NOW()\n" +
  ' WHERE id = $1';

export const PROVENANCE_INSERT_SQL =
  'INSERT INTO dpmaps.provenance_events\n' +
  '  (event_type, record_id, target_record_hash, reason_code, publication_cycle, actor_id, event_hash)\n' +
  "VALUES ('takedown', $1::uuid, $2, $3, $4, $5, $6)";

export class EmergencySuppressionService {
  private readonly sets: SuppressionSetClient;
  private readonly search: SuppressionSearchClient;
  private readonly db: SuppressionDbClient;
  private readonly onError: (info: { tier: string; err: unknown; indexName?: string }) => void;

  constructor(deps: ServiceDeps) {
    this.sets = deps.sets;
    this.search = deps.search;
    this.db = deps.db;
    this.onError = deps.onError ?? (() => undefined);
  }

  /** Fast membership check with DB fallback on Redis failure. */
  async isPlaceSuppressed(targetValue: string): Promise<boolean> {
    try {
      return await this.sets.sismember(REDIS_SUPPRESSION_SET, targetValue);
    } catch (err) {
      this.onError({ tier: 'A-fallback', err });
      const res = await this.db.query(SUPPRESSION_ACTIVE_LOOKUP_SQL, [targetValue]);
      return (res.rowCount ?? 0) > 0;
    }
  }

  /** Tier A+B+C cascade. Throws on Tier C failure (caller rolls back). */
  async executeEmergencySuppression(params: EmergencySuppressionParams): Promise<void> {
    // Tier A: Redis Set add (point semantics; never a Bloom filter).
    await this.sets.sadd(REDIS_SUPPRESSION_SET, params.target_value);

    // Tier B: dual-index eviction (Stage 008 names). Per-index errors are
    // logged and skipped — Tier C is the source of truth.
    for (const indexName of DUAL_SEARCH_INDEXES) {
      try {
        await this.search.deleteDocument(indexName, params.target_value);
      } catch (err) {
        this.onError({ tier: 'B', err, indexName });
      }
    }

    // Tier C: conformant writes.
    const isAuto = params.requester === 'auto_hide';
    await this.db.query(SUPPRESSIONS_INSERT_SQL, [
      params.target_type,
      params.target_value,
      params.reason,
      isAuto,
      isAuto ? 'qualified_traveler_threshold' : null,
      params.reported_at,
      params.tier,
      params.actor_id,
      params.audit_note ?? null,
    ]);
    if (params.target_type === 'poi_id') {
      await this.db.query(POI_SUPPRESS_UPDATE_SQL, [params.target_value]);
    }
    const eventHash = provenanceEventHash(
      params.target_value,
      params.reason,
      params.reported_at.toISOString()
    );
    const recordId =
      params.target_type === 'poi_id'
        ? params.target_value
        : deterministicRecordId('dpmaps-suppression-v1', params.target_type, params.target_value);
    await this.db.query(PROVENANCE_INSERT_SQL, [
      recordId,
      eventHash,
      params.reason,
      'manual',
      params.actor_id,
      eventHash,
    ]);
  }

  /** Restore (TC-011-11): point-delete from the Set + re-index both indexes. */
  async restorePlace(params: {
    target_type: SuppressionTargetType;
    target_value: string;
    actor_id: string;
    reindexedDocument?: Record<string, unknown>;
  }): Promise<void> {
    await this.sets.srem(REDIS_SUPPRESSION_SET, params.target_value);
    if (params.reindexedDocument && this.search.restoreDocument) {
      for (const indexName of DUAL_SEARCH_INDEXES) {
        try {
          await this.search.restoreDocument(indexName, params.reindexedDocument);
        } catch (err) {
          this.onError({ tier: 'restore', err, indexName });
        }
      }
    }
    // Restored places re-enter the pipeline as candidates — never auto-active
    // (bilingual gate + Stage 009 gates decide promotion).
    if (params.target_type === 'poi_id') {
      await this.db.query(
        "UPDATE dpmaps.public_pois SET lifecycle_status = 'candidate', updated_at = NOW() WHERE id = $1",
        [params.target_value]
      );
    }
  }
}