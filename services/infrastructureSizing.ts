/**
 * infrastructureSizing.ts — Stage 016 §2 physics-matched capacity model.
 *
 * Per Stage 004 §2.1: each OSRM profile ≈ 2.4–2.6 GB RSS [ESTIMATE];
 * 3 profiles ≈ 7.2 GB; Blue/Green reload ≈ 14.4 GB. Nodes hosting all
 * three profiles need ≥ 16 GB RAM in every tier — Phase 1 raised to
 * 32 GB because 8–16 GB cannot hold 3 graphs + reload headroom (F-016-1).
 *
 * ALL figures are [ESTIMATE] (AGENTS.md §10: OSRM RAM/throughput/latency
 * on the real graph UNVERIFIED until measured). Tiers: dev, phase1
 * (500–2k rides/d), phase2 (5–10k), scale (10–25k). Network rows included
 * per the audit adoption.
 */

export type ScaleTier = 'dev' | 'phase1' | 'phase2' | 'scale';

export const OSRM_PROFILE_RSS_GB = 2.5; // [ESTIMATE] per-profile RSS
export const OSRM_PROFILES = 3; // car / bike / cng
export const BLUE_GREEN_FACTOR = 2; // reload holds old + new graphs

/** Steady-state graph footprint: 3 × ~2.5 GB ≈ 7.2–7.5 GB. */
export function osrmSteadyGb(): number {
  return OSRM_PROFILE_RSS_GB * OSRM_PROFILES;
}

/** Blue/Green reload footprint ≈ 14.4–15 GB. */
export function osrmReloadGb(): number {
  return osrmSteadyGb() * BLUE_GREEN_FACTOR;
}

export interface NodeSpec {
  vcpu: number;
  ramGb: number;
  nvmeGb: number;
  count: number;
  networkGbps: number;
}

export interface TierTopology {
  osrmPrimary: NodeSpec;
  osrmStandby: NodeSpec;
  meili: NodeSpec; // primary + replica from phase2 (count 2)
  postgres: NodeSpec; // primary + streaming replica from phase2 (count 2)
  redis: NodeSpec; // HA/sentinel from phase2
}

export const SIZING_MATRIX: Record<ScaleTier, TierTopology> = {
  dev: {
    osrmPrimary: { vcpu: 4, ramGb: 16, nvmeGb: 100, count: 1, networkGbps: 1 },
    osrmStandby: { vcpu: 2, ramGb: 8, nvmeGb: 100, count: 1, networkGbps: 1 },
    meili: { vcpu: 2, ramGb: 4, nvmeGb: 50, count: 1, networkGbps: 1 },
    postgres: { vcpu: 4, ramGb: 16, nvmeGb: 100, count: 1, networkGbps: 1 },
    redis: { vcpu: 1, ramGb: 2, nvmeGb: 20, count: 1, networkGbps: 1 },
  },
  phase1: {
    osrmPrimary: { vcpu: 8, ramGb: 32, nvmeGb: 200, count: 1, networkGbps: 1 },
    osrmStandby: { vcpu: 4, ramGb: 16, nvmeGb: 200, count: 1, networkGbps: 1 },
    meili: { vcpu: 2, ramGb: 8, nvmeGb: 50, count: 1, networkGbps: 1 },
    postgres: { vcpu: 4, ramGb: 16, nvmeGb: 250, count: 1, networkGbps: 1 },
    redis: { vcpu: 2, ramGb: 4, nvmeGb: 20, count: 1, networkGbps: 1 },
  },
  phase2: {
    osrmPrimary: { vcpu: 16, ramGb: 32, nvmeGb: 200, count: 1, networkGbps: 2 },
    osrmStandby: { vcpu: 8, ramGb: 32, nvmeGb: 200, count: 1, networkGbps: 2 },
    meili: { vcpu: 4, ramGb: 8, nvmeGb: 50, count: 2, networkGbps: 2 },
    postgres: { vcpu: 8, ramGb: 32, nvmeGb: 500, count: 2, networkGbps: 2 },
    redis: { vcpu: 2, ramGb: 4, nvmeGb: 20, count: 2, networkGbps: 2 },
  },
  scale: {
    osrmPrimary: { vcpu: 16, ramGb: 32, nvmeGb: 200, count: 1, networkGbps: 2 },
    osrmStandby: { vcpu: 8, ramGb: 32, nvmeGb: 200, count: 1, networkGbps: 2 },
    meili: { vcpu: 8, ramGb: 16, nvmeGb: 50, count: 2, networkGbps: 2 },
    postgres: { vcpu: 8, ramGb: 32, nvmeGb: 1000, count: 2, networkGbps: 2 },
    redis: { vcpu: 4, ramGb: 8, nvmeGb: 20, count: 2, networkGbps: 2 },
  },
};

/**
 * F-016-1 physics check: the OSRM primary's RAM must hold the Blue/Green
 * reload footprint (14.4–15 GB) with headroom. Phase-1 32 GB passes;
 * an 8–16 GB node would fail.
 */
export function osrmPrimaryFitsReload(tier: ScaleTier): boolean {
  return SIZING_MATRIX[tier].osrmPrimary.ramGb >= osrmReloadGb();
}

/** HA duplication starts at phase2 (replica counts). */
export function haDuplicated(tier: ScaleTier): boolean {
  const t = SIZING_MATRIX[tier];
  return t.meili.count === 2 && t.postgres.count === 2 && t.redis.count === 2;
}

/** OSRM engine ports (Stage 004 record): car:5001, bike:5002, cng:5003. */
export const OSRM_ENGINE_PORTS = { car: 5001, bike: 5002, cng: 5003 } as const;

/** Failover cutover budget aligns to the canonical 300 ms OSRM timeout. */
export const FAILOVER_CUTOVER_BUDGET_MS = 300;
/** Stage 004 circuit breaker: 3 strikes → standby promotion. */
export const CIRCUIT_BREAKER_STRIKES = 3;
