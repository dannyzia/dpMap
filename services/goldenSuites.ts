/**
 * goldenSuites.ts — Stage 015 §3 golden evaluation sets (F-015-1/4).
 *
 * Search (500): scripts Banglish 50% / Bengali 30% / English 20%; lengths
 * short-prefix 25% / medium 50% / compound 25%; taxonomy transit 20%,
 * residential 25%, medical 15%, commercial 25%, gates 15%.
 * Routing (200 held-out OD pairs): corridor + topology stress (river
 * crossings, flyovers, Old Dhaka alleys; car vs bike vs cng) + TOD
 * windows + SEASON stratification (dry vs monsoon waterlogging replay).
 *
 * This module holds the versioned suite SPEC (strata + counts + season
 * tags). Concrete query/OD fixtures live in versioned data files consumed
 * by workers/benchmarkRunner.ts; the spec validators here guarantee any
 * fixture claiming a suite version matches its strata.
 */

export const SEARCH_SUITE_SIZE = 500;
export const ROUTING_SUITE_SIZE = 200;

export const SEARCH_SCRIPT_STRATA = { banglish: 0.5, bengali: 0.3, english: 0.2 } as const;
export const SEARCH_LENGTH_STRATA = { short_prefix: 0.25, medium: 0.5, compound: 0.25 } as const;
export const SEARCH_TAXONOMY_STRATA = {
  transit: 0.2, residential: 0.25, medical: 0.15, commercial: 0.25, gates: 0.15,
} as const;

export type TodWindow = 'morning_peak' | 'evening_peak' | 'off_peak' | 'night';
export type Season = 'dry' | 'monsoon';

/** TOD replay windows (Dhaka local): 08:30 / 18:00 peaks, 02:00 night sample. */
export const ROUTING_TOD_WINDOWS: { label: TodWindow; localTime: string }[] = [
  { label: 'morning_peak', localTime: '08:30' },
  { label: 'evening_peak', localTime: '18:00' },
  { label: 'off_peak', localTime: '13:00' },
  { label: 'night', localTime: '02:00' },
];

export const MONSOON_MONTHS = [6, 7, 8, 9, 10] as const; // [ESTIMATE — validate vs waterlogging logs]

/** Season tag for a replay month (1–12). */
export function seasonForMonth(month: number): Season {
  return (MONSOON_MONTHS as readonly number[]).includes(month) ? 'monsoon' : 'dry';
}

export interface StrataCounts {
  script: Record<string, number>;
  length: Record<string, number>;
  taxonomy: Record<string, number>;
}

/** Expected absolute counts for the 500-query search suite. */
export function expectedSearchCounts(): StrataCounts {
  const scale = (strata: Record<string, number>) =>
    Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, Math.round(v * SEARCH_SUITE_SIZE)]));
  return {
    script: scale({ ...SEARCH_SCRIPT_STRATA }),
    length: scale({ ...SEARCH_LENGTH_STRATA }),
    taxonomy: scale({ ...SEARCH_TAXONOMY_STRATA }),
  };
}

/** Validate a fixture's strata counts against the spec (exact match). */
export function validateSearchSuite(counts: StrataCounts): string[] {
  const expected = expectedSearchCounts();
  const problems: string[] = [];
  const total = Object.values(counts.script).reduce((a, b) => a + b, 0);
  if (total !== SEARCH_SUITE_SIZE) problems.push(`suite-size:${total}`);
  for (const dim of ['script', 'length', 'taxonomy'] as const) {
    for (const [k, v] of Object.entries(expected[dim])) {
      if ((counts[dim][k] ?? -1) !== v) problems.push(`${dim}.${k}:got=${counts[dim][k] ?? 'missing'},want=${v}`);
    }
  }
  return problems;
}

/** Routing suite descriptor: 200 OD pairs × TOD windows × seasons. */
export function routingReplayPlan(): { odPairs: number; todWindows: TodWindow[]; seasons: Season[] } {
  return {
    odPairs: ROUTING_SUITE_SIZE,
    todWindows: ROUTING_TOD_WINDOWS.map((w) => w.label),
    seasons: ['dry', 'monsoon'],
  };
}
