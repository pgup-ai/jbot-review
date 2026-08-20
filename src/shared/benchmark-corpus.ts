export const BENCHMARK_CATEGORIES = [
  'seeded-defect',
  'historical-accepted',
  'historical-rejected',
  'clean',
  'cross-file-contract',
  'security',
  'data',
  'concurrency',
  'frontend',
  'infrastructure',
  'tests',
  'docs',
  'generated-noise',
  'large-single-file',
  'broad-multi-package',
  'tool-exploration',
] as const;

export const BENCHMARK_RELEASE_SUBSETS = ['smoke', 'core', 'full'] as const;

export type BenchmarkCategory = (typeof BENCHMARK_CATEGORIES)[number];
export type BenchmarkReleaseSubset = (typeof BENCHMARK_RELEASE_SUBSETS)[number];

interface BenchmarkCorpusCaseMetadata {
  id: string;
  categories: BenchmarkCategory[];
  subsets: BenchmarkReleaseSubset[];
  expectedClean: boolean;
  diffSize: string;
  base: string;
  fixturePath?: string;
  repository?: string;
  privateCaseHash?: string;
  counterfactualCaseId?: string;
  counterfactualOf?: string;
}

const CATEGORY_SET = new Set<string>(BENCHMARK_CATEGORIES);
const SUBSET_SET = new Set<string>(BENCHMARK_RELEASE_SUBSETS);

function uniqueKnownValues(value: unknown, allowed: ReadonlySet<string>, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || !allowed.has(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique supported values.`);
  }
  return value as string[];
}

export function validateBenchmarkCorpusMetadata(candidate: Record<string, unknown>): void {
  const categories = uniqueKnownValues(
    candidate.categories,
    CATEGORY_SET,
    `Case ${String(candidate.id)} categories`,
  ) as BenchmarkCategory[];
  const subsets = uniqueKnownValues(
    candidate.subsets,
    SUBSET_SET,
    `Case ${String(candidate.id)} subsets`,
  ) as BenchmarkReleaseSubset[];
  if (!subsets.includes('full')) {
    throw new Error(`Case ${String(candidate.id)} must belong to the full subset.`);
  }
  if (subsets.includes('smoke') && !subsets.includes('core')) {
    throw new Error(`Case ${String(candidate.id)} smoke membership requires core membership.`);
  }
  if (categories.includes('clean') !== (candidate.expectedClean === true)) {
    throw new Error(`Case ${String(candidate.id)} clean category must match expectedClean.`);
  }
}

export function validateBenchmarkCounterfactuals<T extends BenchmarkCorpusCaseMetadata>(
  cases: T[],
): void {
  const byId = new Map(cases.map((candidate) => [candidate.id, candidate]));
  for (const candidate of cases) {
    const pairId = candidate.expectedClean
      ? candidate.counterfactualOf
      : candidate.counterfactualCaseId;
    if (!pairId) {
      throw new Error(`Case ${candidate.id} requires a counterfactual link.`);
    }
    const pair = byId.get(pairId);
    if (!pair || pair.expectedClean === candidate.expectedClean) {
      throw new Error(`Case ${candidate.id} has an invalid counterfactual link.`);
    }
    const reciprocal = pair.expectedClean ? pair.counterfactualOf : pair.counterfactualCaseId;
    if (reciprocal !== candidate.id) {
      throw new Error(`Case ${candidate.id} counterfactual link is not reciprocal.`);
    }
    const candidateSource =
      candidate.fixturePath ?? candidate.repository ?? candidate.privateCaseHash;
    const pairSource = pair.fixturePath ?? pair.repository ?? pair.privateCaseHash;
    if (
      candidate.diffSize !== pair.diffSize ||
      candidate.base !== pair.base ||
      candidateSource !== pairSource ||
      candidate.subsets.join('\0') !== pair.subsets.join('\0')
    ) {
      throw new Error(`Case ${candidate.id} counterfactual does not preserve its change shape.`);
    }
  }
}

export function assertBenchmarkCategoryCoverage<T extends BenchmarkCorpusCaseMetadata>(
  cases: T[],
): void {
  const covered = new Set(cases.flatMap((candidate) => candidate.categories));
  const missing = BENCHMARK_CATEGORIES.filter((category) => !covered.has(category));
  if (missing.length > 0) {
    throw new Error(`Benchmark corpus is missing categories: ${missing.join(', ')}.`);
  }
}

export function selectBenchmarkSubset<T extends BenchmarkCorpusCaseMetadata>(
  cases: T[],
  subset: BenchmarkReleaseSubset,
): T[] {
  return cases.filter((candidate) => candidate.subsets.includes(subset));
}
