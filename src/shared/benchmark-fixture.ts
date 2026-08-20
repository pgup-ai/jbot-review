interface SyntheticFixtureFile {
  path: string;
  patch: string;
}

interface SyntheticFixtureContext {
  before: string;
  after: string;
}

interface SyntheticFixtureShape {
  files: number;
  additions: number;
  deletions: number;
  patchBytes: number;
}

interface MaterializedFixtureFile {
  path: string;
  base: string | null;
  head: string | null;
}

interface ParsedFixtureFile extends MaterializedFixtureFile {
  additions: number;
  deletions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validPath(path: string): boolean {
  const segments = path.split('/');
  return (
    Boolean(path) &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[a-z]:/i.test(path) &&
    !segments.includes('..') &&
    !segments.some((segment) => segment.toLowerCase() === '.git')
  );
}

function hunkOffset(start: number): number {
  return start === 0 ? 0 : start - 1;
}

function contextLines(content: string): string[] {
  return content ? content.replace(/\n$/, '').split('\n') : [];
}

function materializePatch(
  file: SyntheticFixtureFile,
  context?: SyntheticFixtureContext,
): ParsedFixtureFile {
  const base = contextLines(context?.before ?? '');
  const head = [...base];
  let additions = 0;
  let deletions = 0;
  let expectedBase = 0;
  let expectedHead = 0;
  let consumedBase = 0;
  let consumedHead = 0;
  let active = false;

  const finishHunk = (): void => {
    if (active && (consumedBase !== expectedBase || consumedHead !== expectedHead)) {
      throw new Error(`Fixture ${file.path} has an invalid unified-diff hunk length.`);
    }
  };

  for (const line of file.patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      finishHunk();
      const baseOffset = hunkOffset(Number(header[1]));
      const headOffset = hunkOffset(Number(header[3]));
      if (baseOffset < base.length || headOffset < head.length) {
        throw new Error(`Fixture ${file.path} has overlapping unified-diff hunks.`);
      }
      while (base.length < baseOffset) base.push('');
      while (head.length < headOffset) head.push('');
      expectedBase = header[2] === undefined ? 1 : Number(header[2]);
      expectedHead = header[4] === undefined ? 1 : Number(header[4]);
      consumedBase = 0;
      consumedHead = 0;
      active = true;
      continue;
    }
    if (!line || line === '\\ No newline at end of file') continue;
    if (!active) throw new Error(`Fixture ${file.path} requires a valid unified-diff hunk.`);
    const content = line.slice(1);
    if (line.startsWith('-')) {
      base.push(content);
      consumedBase += 1;
      deletions += 1;
    } else if (line.startsWith('+')) {
      head.push(content);
      consumedHead += 1;
      additions += 1;
    } else if (line.startsWith(' ')) {
      base.push(content);
      head.push(content);
      consumedBase += 1;
      consumedHead += 1;
    } else {
      throw new Error(`Fixture ${file.path} has an invalid unified-diff line.`);
    }
  }
  finishHunk();
  if (!active) throw new Error(`Fixture ${file.path} requires a valid unified-diff hunk.`);
  const after = contextLines(context?.after ?? '');
  base.push(...after);
  head.push(...after);
  if (
    [...base, ...head].some(
      (line) =>
        line === 'old behavior' || line === 'old evidence' || /^counterpart \d+$/.test(line),
    )
  ) {
    throw new Error(`Fixture ${file.path} contains placeholder source.`);
  }
  if (base.join('\n') === head.join('\n')) {
    throw new Error(`Fixture ${file.path} materializes no change.`);
  }
  return {
    path: file.path,
    base: base.length > 0 ? `${base.join('\n')}\n` : null,
    head: head.length > 0 ? `${head.join('\n')}\n` : null,
    additions,
    deletions,
  };
}

function fixtureShape(value: unknown, caseId: string): SyntheticFixtureShape {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.files) ||
    (value.files as number) <= 0 ||
    !Number.isInteger(value.additions) ||
    (value.additions as number) < 0 ||
    !Number.isInteger(value.deletions) ||
    (value.deletions as number) < 0 ||
    !Number.isInteger(value.patchBytes) ||
    (value.patchBytes as number) <= 0
  ) {
    throw new Error(`Synthetic benchmark fixture ${caseId} has an invalid shape.`);
  }
  return value as unknown as SyntheticFixtureShape;
}

function appendLine(content: string | null, line: string): string {
  return `${content ?? ''}${line}\n`;
}

function materializeShape(
  files: ParsedFixtureFile[],
  shape: SyntheticFixtureShape,
  paths: Set<string>,
  caseId: string,
): MaterializedFixtureFile[] {
  let additions = files.reduce((sum, file) => sum + file.additions, 0);
  let deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const missingFiles = shape.files - files.length;
  if (
    missingFiles < 0 ||
    shape.additions - additions < missingFiles ||
    shape.deletions - deletions < missingFiles
  ) {
    throw new Error(`Synthetic benchmark fixture ${caseId} does not fit its declared shape.`);
  }
  const fillerChanges = shape.additions - additions + shape.deletions - deletions;
  const width = Math.max(32, Math.ceil(shape.patchBytes / Math.max(1, fillerChanges)));
  const fillerLine = (side: 'base' | 'head'): string =>
    ' '.repeat(side === 'base' ? width : width + 1);
  const paddingFiles: ParsedFixtureFile[] = [];
  const packageRoots = [
    ...new Set(
      files
        .map((file) => /^packages\/[^/]+\//.exec(file.path)?.[0])
        .filter((path): path is string => path !== undefined),
    ),
  ];
  const fillerDirectories = packageRoots.length > 1 ? packageRoots : ['benchmark-shape/'];

  for (let index = 0; index < missingFiles; index += 1) {
    let suffix = index + 1;
    const directory = fillerDirectories[index % fillerDirectories.length];
    let path = `${directory}filler-${String(suffix).padStart(3, '0')}.txt`;
    while (paths.has(path)) {
      suffix += 1;
      path = `${directory}filler-${String(suffix).padStart(3, '0')}.txt`;
    }
    paths.add(path);
    const file = {
      path,
      base: `${fillerLine('base')}\n`,
      head: `${fillerLine('head')}\n`,
      additions: 1,
      deletions: 1,
    };
    files.push(file);
    paddingFiles.push(file);
    additions += 1;
    deletions += 1;
  }
  const paddingTargets = paddingFiles.length > 0 ? paddingFiles : files;
  for (let index = deletions; index < shape.deletions; index += 1) {
    const file = paddingTargets[index % paddingTargets.length];
    file.base = appendLine(file.base, fillerLine('base'));
  }
  for (let index = additions; index < shape.additions; index += 1) {
    const file = paddingTargets[index % paddingTargets.length];
    file.head = appendLine(file.head, fillerLine('head'));
  }
  return files.map(({ path, base, head }) => ({ path, base, head }));
}

export function materializeBenchmarkFixture(
  value: unknown,
  caseId: string,
): MaterializedFixtureFile[] {
  if (!isRecord(value) || !Array.isArray(value.cases)) {
    throw new Error('Synthetic benchmark fixture requires cases.');
  }
  const candidate = value.cases.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === caseId,
  );
  if (!candidate || !Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw new Error(`Synthetic benchmark fixture case not found: ${caseId}.`);
  }
  const family = caseId.replace(/^clean-/, '');
  const contexts = isRecord(value.gitContexts) ? value.gitContexts[family] : undefined;
  if (value.qualityCorpus === true && !isRecord(contexts)) {
    throw new Error(`Synthetic benchmark fixture ${caseId} requires git contexts.`);
  }
  const paths = new Set<string>();
  const files = candidate.files.map((file) => {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      !validPath(file.path) ||
      paths.has(file.path) ||
      typeof file.patch !== 'string'
    ) {
      throw new Error(`Synthetic benchmark fixture ${caseId} has an invalid file.`);
    }
    paths.add(file.path);
    const context = isRecord(contexts) ? contexts[file.path] : undefined;
    if (value.qualityCorpus === true && !isRecord(context)) {
      throw new Error(`Synthetic benchmark fixture ${caseId} lacks context for ${file.path}.`);
    }
    if (
      context !== undefined &&
      (!isRecord(context) ||
        typeof context.before !== 'string' ||
        typeof context.after !== 'string')
    ) {
      throw new Error(
        `Synthetic benchmark fixture ${caseId} has invalid context for ${file.path}.`,
      );
    }
    return materializePatch(
      file as unknown as SyntheticFixtureFile,
      context as unknown as SyntheticFixtureContext | undefined,
    );
  });
  return materializeShape(files, fixtureShape(candidate.shape, caseId), paths, caseId);
}
