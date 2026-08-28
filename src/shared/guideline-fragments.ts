export interface GuidelineFragmentSource {
  id: string;
  label: string;
  text: string;
  relevance: number;
}

export interface GuidelineFragment {
  sourceId: string;
  sourceLabel: string;
  label: string;
  text: string;
  part: number;
  parts: number;
}

interface GuidelineFragmentPlan {
  selected: GuidelineFragment[];
  omittedSourceLabels: string[];
  text: string;
}

function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (!text) return [];
  if (maxBytes < 4) throw new RangeError('maxBytes must be at least 4');
  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;

  const flush = (): void => {
    if (chunk) chunks.push(chunk);
    chunk = '';
    chunkBytes = 0;
  };

  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes <= maxBytes) {
      if (chunkBytes > 0 && chunkBytes + lineBytes > maxBytes) flush();
      chunk += line;
      chunkBytes += lineBytes;
      continue;
    }

    flush();
    for (const char of line) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (chunkBytes > 0 && chunkBytes + charBytes > maxBytes) flush();
      chunk += char;
      chunkBytes += charBytes;
    }
  }
  flush();
  return chunks;
}

function fragmentLabel(source: GuidelineFragmentSource, part: number, parts: number): string {
  return parts === 1 ? source.label : `${source.label} [part ${part}/${parts}]`;
}

/**
 * Split each source, then order equal-relevance fragments round-robin by source.
 * Stable label ordering makes allocation independent of discovery/YAML order.
 */
export function buildGuidelineFragments(
  sources: GuidelineFragmentSource[],
  maxFragmentBytes: number,
): GuidelineFragment[] {
  const grouped = new Map<number, GuidelineFragment[][]>();
  const ordered = [...sources].sort(
    (a, b) =>
      b.relevance - a.relevance || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );

  for (const source of ordered) {
    const chunks = splitByUtf8Bytes(source.text, maxFragmentBytes);
    const fragments = chunks.map((text, index) => ({
      sourceId: source.id,
      sourceLabel: source.label,
      label: fragmentLabel(source, index + 1, chunks.length),
      text,
      part: index + 1,
      parts: chunks.length,
    }));
    const tier = grouped.get(source.relevance) ?? [];
    tier.push(fragments);
    grouped.set(source.relevance, tier);
  }

  const result: GuidelineFragment[] = [];
  for (const relevance of [...grouped.keys()].sort((a, b) => b - a)) {
    const tier = grouped.get(relevance)!;
    const rounds = Math.max(0, ...tier.map((fragments) => fragments.length));
    for (let round = 0; round < rounds; round += 1)
      for (const fragments of tier) {
        const fragment = fragments[round];
        if (fragment) result.push(fragment);
      }
  }
  return result;
}

export function buildFairGuidelineFragments(
  sources: GuidelineFragmentSource[],
  capBytes: number,
  maxFragmentBytes: number,
): GuidelineFragment[] {
  const topRelevance = Math.max(...sources.map((source) => source.relevance));
  const topTierSize = sources.filter((source) => source.relevance === topRelevance).length;
  const firstRoundBudget = Math.floor((capBytes * 2) / 3);
  const fragmentBytes = Math.min(
    maxFragmentBytes,
    Math.max(4, Math.floor(firstRoundBudget / Math.max(6, topTierSize))),
  );
  return buildGuidelineFragments(sources, fragmentBytes);
}

export function selectGuidelineFragments(
  fragments: GuidelineFragment[],
  capBytes: number,
  render: (fragment: GuidelineFragment) => string,
  separator = '\n\n',
): GuidelineFragmentPlan {
  const selected: GuidelineFragment[] = [];
  const blocked = new Set<string>();
  let usedBytes = 0;

  for (const fragment of fragments) {
    if (blocked.has(fragment.sourceId)) continue;
    const rendered = render(fragment);
    const bytes =
      Buffer.byteLength(rendered, 'utf8') +
      (selected.length > 0 ? Buffer.byteLength(separator, 'utf8') : 0);
    if (usedBytes + bytes > capBytes) {
      blocked.add(fragment.sourceId);
      continue;
    }
    selected.push(fragment);
    usedBytes += bytes;
  }

  const selectedParts = new Map<string, number>();
  for (const fragment of selected)
    selectedParts.set(fragment.sourceId, (selectedParts.get(fragment.sourceId) ?? 0) + 1);
  const omittedSourceLabels = [
    ...new Map(
      fragments
        .filter((fragment) => (selectedParts.get(fragment.sourceId) ?? 0) < fragment.parts)
        .map((fragment) => [fragment.sourceId, fragment.sourceLabel]),
    ).values(),
  ];

  return {
    selected,
    omittedSourceLabels,
    text: selected.map(render).join(separator),
  };
}
