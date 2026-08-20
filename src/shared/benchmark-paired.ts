import { benchmarkPercentile, benchmarkRandom, type BenchmarkInterval } from './benchmark-score.ts';
import type { BenchmarkCaseRow } from './benchmark-rescore.ts';

const PERMUTATIONS = 10_000;
/** Coarser resolution inside power trials, which run the test thousands of times. */
const POWER_PERMUTATIONS = 200;
const BOOTSTRAP_SAMPLES = 2_000;
const SEED = 0x5eed;
const TARGET_POWER = 0.8;

/** Candidate effects scanned for the minimum detectable effect, in percent. */
const EFFECT_LADDER = [2, 5, 7.5, 10, 15, 20, 25, 30, 40, 50];

export interface BenchmarkPair {
  caseId: string;
  repetition: number;
  controlMs: number;
  treatmentMs: number;
  /** Treatment relative to control, in percent; negative means the treatment is faster. */
  relativeDelta: number;
}

export interface PairedBenchmarkSummary {
  pairs: number;
  medianRelativeDelta: number | null;
  ci95: BenchmarkInterval | null;
  /** Two-sided p-value from swapping arm labels within pairs, which is exchangeable under the null. */
  permutationP: number | null;
  treatmentFaster: number;
  /** Smallest effect detectable at 80% power; a gate below it is unanswerable. */
  minimumDetectableEffect: number | null;
}

/**
 * Pairs arms by (caseId, repetition) so case difficulty cancels: a pooled median
 * over cases differing several-fold in cost tracks the median case, not a
 * uniform shift. Failed runs drop with their partner, keeping arms equal.
 */
export function pairBenchmarkRuns(rows: readonly BenchmarkCaseRow[]): BenchmarkPair[] {
  const arms = {
    control: new Map<string, BenchmarkCaseRow>(),
    treatment: new Map<string, BenchmarkCaseRow>(),
  };
  for (const row of rows) {
    if (row.failureClass !== null) continue;
    arms[row.arm].set(`${row.caseId}:${row.repetition}`, row);
  }
  const pairs: BenchmarkPair[] = [];
  for (const [key, control] of [...arms.control].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const treatment = arms.treatment.get(key);
    if (!treatment) continue;
    const controlMs = control.latencyMs;
    if (controlMs <= 0) continue;
    const treatmentMs = treatment.latencyMs;
    pairs.push({
      caseId: control.caseId,
      repetition: control.repetition,
      controlMs,
      treatmentMs,
      relativeDelta: ((treatmentMs - controlMs) / controlMs) * 100,
    });
  }
  return pairs;
}

function median(values: readonly number[]): number {
  return benchmarkPercentile([...values], 0.5) ?? 0;
}

/**
 * Wilcoxon signed-rank: outlier-resistant like a median, but it uses magnitude,
 * which a median-based test needs — that one cannot resolve even a unanimous
 * effect at realistic pair counts. Exact zeros carry no direction.
 */
function signedRankStatistic(deltas: readonly number[]): number {
  const ordered = deltas
    .map((delta) => ({ delta, magnitude: Math.abs(delta) }))
    .filter((entry) => entry.magnitude > 0)
    .sort((a, b) => a.magnitude - b.magnitude);
  let statistic = 0;
  for (let start = 0; start < ordered.length;) {
    // Tied magnitudes share the average of the ranks they span.
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].magnitude === ordered[start].magnitude)
      end += 1;
    const rank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1) {
      statistic += ordered[index].delta < 0 ? -rank : rank;
    }
    start = end + 1;
  }
  return statistic;
}

function permutationP(deltas: readonly number[], next: () => number, permutations: number): number {
  const observed = Math.abs(signedRankStatistic(deltas));
  let extreme = 0;
  const flipped: number[] = Array.from({ length: deltas.length }, () => 0);
  for (let sample = 0; sample < permutations; sample += 1) {
    for (let index = 0; index < deltas.length; index += 1) {
      flipped[index] = next() < 0.5 ? deltas[index] : -deltas[index];
    }
    if (Math.abs(signedRankStatistic(flipped)) >= observed) extreme += 1;
  }
  // Add-one keeps the p-value away from zero, which no finite permutation set earns.
  return (extreme + 1) / (permutations + 1);
}

/**
 * Rejection rate for a true effect of `effect` percent. Centring before shifting
 * keeps this sample's spread but drops its observed effect, so the answer
 * describes the design rather than restating the measurement.
 */
function power(
  deltas: readonly number[],
  effect: number,
  next: () => number,
  trials: number,
): number {
  const centre = median(deltas);
  const centred = deltas.map((delta) => delta - centre);
  let detected = 0;
  const sample: number[] = Array.from({ length: deltas.length }, () => 0);
  for (let trial = 0; trial < trials; trial += 1) {
    for (let index = 0; index < deltas.length; index += 1) {
      sample[index] = centred[Math.floor(next() * centred.length)] - effect;
    }
    if (permutationP(sample, next, POWER_PERMUTATIONS) < 0.05) detected += 1;
  }
  return detected / trials;
}

function minimumDetectableEffect(deltas: readonly number[], next: () => number): number | null {
  for (const effect of EFFECT_LADDER) {
    if (power(deltas, effect, next, 60) >= TARGET_POWER) return effect;
  }
  return null;
}

export function summarizePairedBenchmark(pairs: readonly BenchmarkPair[]): PairedBenchmarkSummary {
  if (pairs.length < 2) {
    return {
      pairs: pairs.length,
      medianRelativeDelta: pairs.length === 1 ? pairs[0].relativeDelta : null,
      ci95: null,
      permutationP: null,
      treatmentFaster: pairs.filter((pair) => pair.treatmentMs < pair.controlMs).length,
      minimumDetectableEffect: null,
    };
  }
  const deltas = pairs.map((pair) => pair.relativeDelta);
  const next = benchmarkRandom(SEED);
  const resampled: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    resampled.push(
      median(
        Array.from({ length: deltas.length }, () => deltas[Math.floor(next() * deltas.length)]),
      ),
    );
  }
  const low = benchmarkPercentile(resampled, 0.025);
  const high = benchmarkPercentile(resampled, 0.975);
  return {
    pairs: pairs.length,
    medianRelativeDelta: median(deltas),
    ci95: low === null || high === null ? null : { low, high },
    permutationP: permutationP(deltas, next, PERMUTATIONS),
    treatmentFaster: pairs.filter((pair) => pair.treatmentMs < pair.controlMs).length,
    minimumDetectableEffect: minimumDetectableEffect(deltas, next),
  };
}
