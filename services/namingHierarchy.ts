/**
 * namingHierarchy.ts — Stage 010 §2 4-tier display-name authority hierarchy.
 *
 *   TIER 1 — Survey & Merchant Onboarding ('pin_tool' / 'merchant_onboarding'):
 *            authoritative; overrides all crowdsourced strings.
 *   TIER 2 — Post-Trip Rider Consensus (aggregated, never individual).
 *   TIER 3 — Formatted Canonical Query (Stage 007/009 leading normalized
 *            variant — NEVER the raw majority string; scrubPii + sanitizer).
 *   TIER 4 — Ephemeral Vendor Passthrough / Coarse Centroid: DISPLAY-ONLY.
 *
 * INVARIANT (TC-010-15): Tier 4 text is never persisted — not into
 * public_pois, not into poi_aliases, not into receipts, not into Meili.
 * assertTier4NeverPersists() throws if Tier-4 text reaches a write path.
 *
 * Zero dependencies. Pure functions; production wiring (provenance JSONB
 * tier tags) is documented in the header comments of the SQL builders.
 */

export type DisplayTier = 'tier_1' | 'tier_2' | 'tier_3' | 'tier_4_display_only';

export type NameSourceType =
  | 'pin_tool'
  | 'merchant_onboarding'
  | 'post_trip_consensus'
  | 'canonical_query'
  | 'vendor_passthrough';

export function tierForSource(source: NameSourceType): DisplayTier {
  switch (source) {
    case 'pin_tool':
    case 'merchant_onboarding':
      return 'tier_1';
    case 'post_trip_consensus':
      return 'tier_2';
    case 'canonical_query':
      return 'tier_3';
    case 'vendor_passthrough':
      return 'tier_4_display_only';
  }
}

export interface TieredNameCandidate {
  source: NameSourceType;
  /** Display string for this tier (undefined = tier has no name). */
  text?: string;
  /** Tier 2 only: quorum/consensus proof attached at aggregation time. */
  consensusProof?: { distinctRiders: number; share: number };
}

/**
 * Strict precedence: the highest tier WITH a name wins.
 * Lower tiers never override higher ones. Tier 4 wins only when no
 * higher tier has a name — and the result is still display-only.
 */
export function resolveDisplayName(cands: TieredNameCandidate[]): {
  text?: string;
  tier: DisplayTier | 'none';
  source?: NameSourceType;
} {
  const rank: Record<DisplayTier, number> = {
    tier_1: 0,
    tier_2: 1,
    tier_3: 2,
    tier_4_display_only: 3,
  };
  const ordered = [...cands]
    .filter((c) => c.text && c.text.trim().length > 0)
    .sort((a, b) => rank[tierForSource(a.source)] - rank[tierForSource(b.source)]);
  if (ordered.length === 0) return { tier: 'none' };
  const win = ordered[0];
  return { text: win.text, tier: tierForSource(win.source), source: win.source };
}

/** Provenance tag written on Tier 2 promotion (plan §6 step 3). */
export const TIER_2_PROVENANCE_TAG = { tier: 'tier_2', verified_by: 'post_trip_consensus' };

/**
 * Clean-room persistence guard (TC-010-15). Call from EVERY write path
 * that touches public_pois / poi_aliases / receipts / Meili feeds:
 * vendor-passthrough text must never arrive here.
 */
export function assertTier4NeverPersists(text: string | undefined, source: NameSourceType): void {
  if (source === 'vendor_passthrough' && text && text.trim().length > 0) {
    throw new Error(
      'STAGE010-TIER4: vendor passthrough text is display-only and must never be persisted'
    );
  }
}

/**
 * Tier 2 promotion guard (F-010-3): an individual label — however clean —
 * never renames anything. Only the aggregator's consensus result may
 * promote, and it must carry quorum proof.
 */
export function assertConsensusPromotion(proof?: { distinctRiders: number; share: number }): void {
  if (!proof || proof.distinctRiders < 5 || proof.share < 0.6) {
    throw new Error('STAGE010-TIER2: individual labels never rename; quorum (≥5) + consensus (≥60%) required [ESTIMATE]');
  }
}
