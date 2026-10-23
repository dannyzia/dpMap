/**
 * searchTelemetry.ts — Stage 008 §4.1/F-008-6 selection-time telemetry.
 *
 * Emitted ONLY on final selection (rider tap) — never a raw keystroke
 * stream (Hard Rule 8). The typed query is scrubbed (Stage 002 contract)
 * and truncated to 80 chars before persistence.
 *
 * SCHEMA OF RECORD (Stage 003 §4.7, verified): selection rows persist to
 * dpmaps.raw_search_events with EXACT columns
 *   (user_id, typed_query VARCHAR(80), selected_source, selected_place_id,
 *    latency_ms) — selected_source ∈ ('dpmaps','osm','vendor','history'),
 *   first-party items map to 'dpmaps', vendor rows carry NULL place_id
 *   (chk_raw_vendor_place_null). Neither raw_search_events nor
 *   search_eval_events has position / search_session_id columns, so those
 *   two values are returned in-memory for metrics/impression use only and
 *   NEVER written to Postgres. Extending the schema is an orchestrator +
 *   Stage 003 migration decision (flagged as QUESTION on the hub).
 *
 * Zero vendor strings persist: vendor display names are response-only.
 */

import { scrubPii } from '../utils-server/vendorClientWrapper';

export type SelectionSource = 'first_party' | 'osm' | 'vendor';

/** Schema enum of record (Stage 003 chk: 'dpmaps','osm','vendor','history'). */
export type StoredSource = 'dpmaps' | 'osm' | 'vendor';

export const MAX_TYPED_QUERY_CHARS = 80;

/** Exact dpmaps.raw_search_events insert shape. No other keys permitted. */
export interface SearchSelectionRow {
  user_id: string;
  typed_query: string;
  selected_source: StoredSource;
  selected_place_id: string | null;
  latency_ms: number;
}

export const SEARCH_SELECTION_COLUMNS: readonly (keyof SearchSelectionRow)[] = [
  'user_id',
  'typed_query',
  'selected_source',
  'selected_place_id',
  'latency_ms',
];

/** Keys that must NEVER reach a dpmaps-bound telemetry row. */
const FORBIDDEN_KEYS = [
  'raw_query',
  'keystrokes',
  'keystroke',
  'display_name',
  'secondary_text',
  'coords',
  'lat',
  'lng',
  'polyline',
  'temp_client_id',
  'session_token',
  'trip_id',
];

export interface SelectionEvent {
  userId: string;
  rawQuery: string;
  source: SelectionSource;
  /** Local document ID (pub_* / osm_*). Ignored (forced NULL) for vendor. */
  placeId?: string | null;
  latencyMs: number;
  /** In-memory only: dropdown position tapped (no DB column — see header). */
  position: number;
  /** In-memory only: session ID for metrics correlation (no DB column). */
  searchSessionId: string;
}

/**
 * Builds the persisted row + the in-memory-only context. The scrubbed
 * query is truncated to 80 chars; vendor rows force selected_place_id NULL.
 */
export function buildSelectionRow(event: SelectionEvent): {
  row: SearchSelectionRow;
  context: { position: number; search_session_id: string };
} {
  if (!event.userId) throw new Error('buildSelectionRow: userId required');
  if (!(event.latencyMs >= 0)) throw new Error('buildSelectionRow: latencyMs must be >= 0');
  const stored: StoredSource = event.source === 'vendor' ? 'vendor' : event.source === 'osm' ? 'osm' : 'dpmaps';
  const row: SearchSelectionRow = {
    user_id: event.userId,
    typed_query: scrubPii(event.rawQuery).substring(0, MAX_TYPED_QUERY_CHARS),
    selected_source: stored,
    selected_place_id: stored === 'vendor' ? null : (event.placeId ?? null),
    latency_ms: Math.round(event.latencyMs),
  };
  return {
    row,
    context: { position: event.position, search_session_id: event.searchSessionId },
  };
}

export interface TelemetryDb {
  query: (text: string, params: unknown[]) => Promise<unknown>;
}

/**
 * Inserts the selection row into dpmaps.raw_search_events. Throws on any
 * forbidden key or any column outside the §4.7 contract.
 */
export async function persistSelection(
  db: TelemetryDb,
  row: SearchSelectionRow,
): Promise<void> {
  const keys = Object.keys(row);
  for (const k of keys) {
    if (FORBIDDEN_KEYS.includes(k)) {
      throw new Error(`persistSelection: forbidden key '${k}' — clean-room violation`);
    }
    if (!(SEARCH_SELECTION_COLUMNS as readonly string[]).includes(k)) {
      throw new Error(`persistSelection: unknown column '${k}' — not in §4.7 contract`);
    }
  }
  for (const c of SEARCH_SELECTION_COLUMNS) {
    if (!(c in row)) throw new Error(`persistSelection: missing column '${c}'`);
  }
  await db.query(
    `INSERT INTO dpmaps.raw_search_events (user_id, typed_query, selected_source, selected_place_id, latency_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    SEARCH_SELECTION_COLUMNS.map((c) => (row as unknown as Record<string, unknown>)[c]),
  );
}

/**
 * Impression accounting (plan refinement F-008-6): unselected impressions
 * feed Prometheus counters only. This builder carries NO query text at all —
 * not even scrubbed — so it is safe to emit per keystroke downstream.
 */
export function buildImpressionEvent(source: SelectionSource, latencyMs: number): {
  source: SelectionSource;
  latency_ms: number;
} {
  return { source, latency_ms: Math.round(latencyMs) };
}
