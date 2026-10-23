/**
 * workers/benchmarkRunner.ts — Stage 015 §6 nightly benchmark runner.
 *
 * Executes golden suites against stage-tagged endpoints, computes §4
 * statistics from routing_eval_events/search_eval_events rows, and emits
 * a versioned scorecard with release-manifest hash chaining (Stage 009
 * §11 pattern). No vendor quotes appear in scorecards — percentages only.
 *
 * Zero infra deps: suite rows + scorecard sink arrive injected; hashing
 * uses node:crypto (stdlib).
 */

import { createHash } from 'node:crypto';
import {
  evaluateGate1A,
  evaluateGate1B,
  evaluateGate2,
  RoutingWeek,
  SearchWeek,
} from '../services/cutoverGateEvaluator';

export interface ScorecardSink {
  write(scorecard: Scorecard): void | Promise<void>;
}

export interface Scorecard {
  suite_version: string;
  release_manifest_hash: string;
  prev_scorecard_hash: string;
  scorecard_hash: string;
  gate1a: boolean;
  gate1b: boolean;
  gate2: boolean;
  computed_at: string;
}

/** Hash-chain a scorecard to the previous one (tamper-evident sequence). */
export function hashScorecard(body: Omit<Scorecard, 'scorecard_hash'>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export async function runBenchmark(
  sink: ScorecardSink,
  args: {
    suiteVersion: string;
    releaseManifestHash: string;
    prevScorecardHash: string;
    routingWeeks: RoutingWeek[];
    searchWeeks: SearchWeek[];
    nowIso?: string;
  }
): Promise<Scorecard> {
  const gate1a = evaluateGate1A(args.routingWeeks);
  const gate1b = evaluateGate1B(args.searchWeeks);
  const gate2 = evaluateGate2(args.routingWeeks, args.searchWeeks);
  const body = {
    suite_version: args.suiteVersion,
    release_manifest_hash: args.releaseManifestHash,
    prev_scorecard_hash: args.prevScorecardHash,
    gate1a,
    gate1b,
    gate2,
    computed_at: args.nowIso ?? new Date().toISOString(),
  };
  const card: Scorecard = { ...body, scorecard_hash: hashScorecard(body) };
  await sink.write(card);
  return card;
}
