interface SyntheticFixtureFile {
  path: string;
  patch: string;
}

interface SyntheticFixtureShape {
  files: number;
  additions: number;
  deletions: number;
  patchBytes: number;
}

interface MaterializedFixtureFile {
  path: string;
  base: string;
  head: string;
}

interface ParsedFixtureFile extends MaterializedFixtureFile {
  additions: number;
  deletions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validPath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..');
}

function hunkOffset(start: number): number {
  return start === 0 ? 0 : start - 1;
}

function materializePatch(file: SyntheticFixtureFile): ParsedFixtureFile {
  const base: string[] = [];
  const head: string[] = [];
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
  return {
    path: file.path,
    base: `${base.join('\n')}\n`,
    head: `${head.join('\n')}\n`,
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

function appendLine(content: string, line: string): string {
  return `${content}${line}\n`;
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
  const fillerLine = (side: 'base' | 'head', index: number): string =>
    `${side}-${index}-`.padEnd(width, side === 'base' ? 'b' : 'h');

  for (let index = 0; index < missingFiles; index += 1) {
    let suffix = index + 1;
    let path = `benchmark-shape/filler-${String(suffix).padStart(3, '0')}.txt`;
    while (paths.has(path)) {
      suffix += 1;
      path = `benchmark-shape/filler-${String(suffix).padStart(3, '0')}.txt`;
    }
    paths.add(path);
    files.push({
      path,
      base: `${fillerLine('base', deletions)}\n`,
      head: `${fillerLine('head', additions)}\n`,
      additions: 1,
      deletions: 1,
    });
    additions += 1;
    deletions += 1;
  }
  for (let index = deletions; index < shape.deletions; index += 1) {
    const file = files[index % files.length];
    file.base = appendLine(file.base, fillerLine('base', index));
  }
  for (let index = additions; index < shape.additions; index += 1) {
    const file = files[index % files.length];
    file.head = appendLine(file.head, fillerLine('head', index));
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
    return materializePatch(file as unknown as SyntheticFixtureFile);
  });
  return materializeShape(files, fixtureShape(candidate.shape, caseId), paths, caseId);
}
