interface SyntheticFixtureFile {
  path: string;
  patch: string;
}

interface MaterializedFixtureFile {
  path: string;
  base: string;
  head: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validPath(path: string): boolean {
  return Boolean(path) && !path.startsWith('/') && !path.split('/').includes('..');
}

function materializePatch(file: SyntheticFixtureFile): MaterializedFixtureFile {
  const lines = file.patch.split('\n');
  const header = lines.findIndex((line) => line.startsWith('@@ '));
  const match = header >= 0 ? /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[header]) : null;
  if (!match) throw new Error(`Fixture ${file.path} requires one valid unified-diff hunk.`);
  const base = Array.from({ length: Number(match[1]) - 1 }, () => '');
  const head = Array.from({ length: Number(match[2]) - 1 }, () => '');
  for (const line of lines.slice(header + 1)) {
    if (!line) continue;
    if (line.startsWith('-')) base.push(line.slice(1));
    else if (line.startsWith('+')) head.push(line.slice(1));
    else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      base.push(content);
      head.push(content);
    }
  }
  return { path: file.path, base: `${base.join('\n')}\n`, head: `${head.join('\n')}\n` };
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
  return candidate.files.map((file) => {
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
}
