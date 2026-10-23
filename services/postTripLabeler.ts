/**
 * postTripLabeler.ts — Stage 010 §4 post-trip label collection protocol.
 *
 * Staging ONLY (F-010-3): submissions land in dpmaps.post_trip_labels and
 * NEVER rename anything. Convergence + privacy filters (the aggregator)
 * decide; one submission per rider per place per publication cycle
 * (uq_rider_poi_cycle).
 *
 * Write rule: scrubbed at write (scrubPii + length cap). Normalized form
 * comes from the Stage 007 normalizer so labels aggregate on the same
 * cluster keys as trip votes.
 *
 * NULL-poi caveat (schema-conformant): uq_rider_poi_cycle is
 * UNIQUE (poi_id, pseudonym_hash, publication_cycle), but PostgreSQL treats
 * NULL poi_id values as DISTINCT — the constraint does NOT dedupe
 * unindexed-cell rows (poi_id NULL). The worker MUST enforce the
 * (h3_res10, pseudonym_hash, publication_cycle) key in code (F-010-6 path).
 * isDuplicateSubmission() below implements both keys.
 *
 * Zero DB driver dependency: pure staging-row builders + in-memory dedupe
 * helpers. Production wiring (INSERT … ON CONFLICT DO NOTHING + worker-side
 * NULL-poi check) is shown in the header SQL comment.
 *
 * ```sql
 * -- Indexed path: constraint dedupes.
 * INSERT INTO dpmaps.post_trip_labels
 *   (poi_id, h3_res10, submitted_text, normalized_text,
 *    submission_type, pseudonym_hash, trip_hash, publication_cycle)
 * VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
 * ON CONFLICT DO NOTHING;  -- uq_rider_poi_cycle: second submit discarded
 * -- Unindexed path (poi_id NULL): pre-check in code with
 * -- isDuplicateSubmission() on (h3_res10, pseudonym_hash, publication_cycle)
 * -- BEFORE insert, because the UNIQUE constraint ignores NULL poi_id rows.
 * ```
 */

import { scrubPii } from '../utils-server/vendorClientWrapper';
import { normalizeSearchQuery } from '../utils-server/textNormalizer';

export type SubmissionType = 'text_entry' | 'chip_selection';

/** Source-kind of the label text (TC-010-15: vendor text rejected at ingest). */
export type LabelSourceKind = 'rider_typed' | 'chip' | 'vendor_passthrough';

export interface PostTripLabelInput {
  poi_id: string | null; // NULL for unindexed destination cells (F-010-6)
  h3_res10: string;
  submitted_text_raw: string; // raw rider keystrokes — scrubbed before staging
  submission_type: SubmissionType;
  sourceKind: LabelSourceKind;
  pseudonym_hash: string; // CHAR(64) hex
  trip_hash: string; // CHAR(64) hex
  publication_cycle: string;
}

export interface StagedPostTripLabel {
  poi_id: string | null;
  h3_res10: string;
  submitted_text: string; // scrubbed, ≤120
  normalized_text: string; // Stage 007 form, ≤120
  submission_type: SubmissionType;
  pseudonym_hash: string;
  trip_hash: string;
  publication_cycle: string;
}

export interface LabelIngestResult {
  staged: boolean;
  row?: StagedPostTripLabel;
  rejection_reason?: 'vendor_text' | 'empty' | 'overlong' | 'bad_submission_type' | 'bad_hash' | 'missing_cell';
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * Stage a post-trip label (F-010-3). Returns { staged:false } for rejects —
 * rejects never reach the table.
 */
export function stagePostTripLabel(input: PostTripLabelInput): LabelIngestResult {
  // TC-010-15: Tier 4 vendor text rejected at ingest (clean-room invariant).
  // Soft-reject (no throw) so dispatch can log-and-drop; the throwing guard
  // below stays as defense-in-depth for persistence call sites.
  if (input.sourceKind === 'vendor_passthrough') {
    return { staged: false, rejection_reason: 'vendor_text' };
  }
  if (input.submission_type !== 'text_entry' && input.submission_type !== 'chip_selection') {
    return { staged: false, rejection_reason: 'bad_submission_type' };
  }
  if (!input.h3_res10 || input.h3_res10.trim().length === 0) {
    return { staged: false, rejection_reason: 'missing_cell' };
  }
  if (!HEX64.test(input.pseudonym_hash) || !HEX64.test(input.trip_hash)) {
    return { staged: false, rejection_reason: 'bad_hash' };
  }
  // Scrubbed at write (plan §4): scrubPii first, then the 120-char bound.
  const scrubbed = scrubPii(input.submitted_text_raw).trim().replace(/\s+/g, ' ');
  if (scrubbed.length === 0) return { staged: false, rejection_reason: 'empty' };
  if (scrubbed.length > 120) return { staged: false, rejection_reason: 'overlong' };

  // Stage 007 normalized form — labels aggregate on cluster keys.
  const norm = normalizeSearchQuery(scrubbed).normalized_query.slice(0, 120);

  return {
    staged: true,
    row: {
      poi_id: input.poi_id,
      h3_res10: input.h3_res10,
      submitted_text: scrubbed.slice(0, 120),
      normalized_text: norm,
      submission_type: input.submission_type,
      pseudonym_hash: input.pseudonym_hash.toLowerCase(),
      trip_hash: input.trip_hash.toLowerCase(),
      publication_cycle: input.publication_cycle,
    },
  };
}

/**
 * Cycle-bounded uniqueness (TC-010-12):
 * - poi_id NOT NULL → (poi_id, pseudonym_hash, publication_cycle)
 *   (mirrors uq_rider_poi_cycle).
 * - poi_id NULL → (h3_res10, pseudonym_hash, publication_cycle) IN CODE,
 *   because the PG UNIQUE constraint does not dedupe NULL poi_id rows.
 */
export function isDuplicateSubmission(
  existing: Pick<StagedPostTripLabel, 'poi_id' | 'h3_res10' | 'pseudonym_hash' | 'publication_cycle'>[],
  candidate: Pick<StagedPostTripLabel, 'poi_id' | 'h3_res10' | 'pseudonym_hash' | 'publication_cycle'>
): boolean {
  return existing.some((e) => {
    if (e.publication_cycle !== candidate.publication_cycle) return false;
    if (e.pseudonym_hash.toLowerCase() !== candidate.pseudonym_hash.toLowerCase()) return false;
    if (e.poi_id !== null && candidate.poi_id !== null) return e.poi_id === candidate.poi_id;
    if (e.poi_id === null && candidate.poi_id === null) return e.h3_res10 === candidate.h3_res10;
    return false;
  });
}

/** Prompt scope (plan §4): strong Layer-2 evidence, no Tier 1 name, <10% sample. */
export function shouldPromptForLabel(args: {
  hasStrongLayer2Evidence: boolean;
  hasTier1Name: boolean;
  sampleRoll: number; // uniform [0,1)
  samplingRateCap?: number; // [ESTIMATE] default 0.10
}): boolean {
  const cap = args.samplingRateCap ?? 0.10;
  if (args.hasTier1Name) return false;
  if (!args.hasStrongLayer2Evidence) return false;
  return args.sampleRoll >= 0 && args.sampleRoll < cap;
}
