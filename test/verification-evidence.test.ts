import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EvidenceStore, indexEvidenceSource } from '../src/shared/evidence.ts';
import {
  collectStateEvidence,
  stateEvidenceTerms,
  VerificationEvidence,
} from '../src/shared/verification-evidence.ts';
import { checkVerificationProof } from '../src/shared/filter.ts';
import { parseFindingVerdicts } from '../src/shared/opencode.ts';
import { parseVerificationProof, type Finding, type FindingVerdict } from '../src/shared/types.ts';
import { requestFindingVerdicts } from '../src/shared/runner.ts';

const finding: Finding = {
  path: 'delete.ts',
  line: 2,
  title: 'Closed history can survive deletion',
  body: 'The record.stage check for Stage.CLOSED overlooks older closed entries while a revision is pending.',
  kind: 'bug',
  severity: 'P2',
};
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const workspace = await mkdtemp(join(tmpdir(), 'state-evidence-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const files = {
    'delete.ts':
      'export function remove(record) {\n  if (record.stage === Stage.CLOSED) throw Error();\n  removeLink(record.id);\n}',
    'state.ts': "export enum Stage { CLOSED = 'closed', REVISING = 'revising' }",
    'producer.ts':
      "import { Repo } from './repo';\nexport class Service {\n  constructor(private repo: Repo) {}\n  createRevision(id) {\n    this.assertAllowed(id);\n    return this.repo.update({ id, stage: Stage.REVISING });\n  }\n  assertAllowed(id) {\n    if (!id) throw Error();\n  }\n}",
    'bridge.ts':
      'export function guard(record, latest) { return latest.status === EntryStatus.CLOSED && record.stage === Stage.CLOSED; }',
    'ignored.api-spec.ts': 'function createWrong() { return { stage: Stage.REVISING }; }',
    'repo.ts':
      'export class Repo {\n  update(data) {\n    return db.update({ id: data.id }, { stage: data.stage });\n  }\n}',
    'query.ts':
      'export function updateStatusQuery() { return repo.find({ status: { $ne: Stage.CLOSED } }); }',
    'comment.ts':
      '// pretend producer: stage: Stage.REVISING\nconst label = "stage: Stage.REVISING";\n',
  };
  for (const [path, text] of Object.entries(files)) await writeFile(join(workspace, path), text);
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'synthetic'],
    { cwd: workspace },
  );
  return { workspace, files };
}
const proof = {
  trigger: 'Create a pending revision, then remove its link.',
  producer: [
    {
      path: 'producer.ts',
      line: 6,
      quote: 'return this.repo.update({ id, stage: Stage.REVISING });',
    },
  ],
  guard: [
    { path: 'delete.ts', line: 2, quote: 'if (record.stage === Stage.CLOSED) throw Error();' },
  ],
  effect: [{ path: 'delete.ts', line: 3, quote: 'removeLink(record.id);' }],
};
const confirmed: FindingVerdict = { index: 0, verdict: 'confirmed', reason: 'Traced path', proof };

test('retrieves an alternative state writer with its guard and persistence method without a hand-picked producer name', async (t) => {
  const { workspace } = await fixture(t);
  const store = new EvidenceStore(workspace, []);
  const packet = await collectStateEvidence(
    await store.packProvider(AbortSignal.timeout(4000)),
    [
      {
        ...finding,
        body: 'The record.stage === CLOSED and latest.status === CLOSED checks miss old entries.',
      },
    ],
    'EntryStatus.CLOSED',
  );
  assert.match(packet, /createRevision/);
  assert.match(packet, /assertAllowed/);
  assert.match(packet, /repo.ts[^]*db.update/);
  assert.doesNotMatch(
    packet,
    /comment.ts|pretend producer|export enum|ignored.api-spec|updateStatusQuery/,
  );
  assert.ok(Buffer.byteLength(packet) <= 16 * 1024);
  assert.match(packet, /Omitted candidates:/);
  assert.deepEqual(stateEvidenceTerms([{ ...finding, kind: 'docs' }], 'Stage.CLOSED').enums, []);
  assert.deepEqual(
    stateEvidenceTerms(
      [{ ...finding, body: '`src/delete.service.ts` checks record.stage === CLOSED.' }],
      'RecordStage.CLOSED OtherStatus.CLOSED HttpStatus.OK',
    ),
    { fields: [], enums: ['RecordStage'] },
  );
  assert.deepEqual(
    stateEvidenceTerms(
      [{ ...finding, body: 'order.type is recorded as AuditType.ORDER.' }],
      'OrderType.EXPENSE UnrelatedType.ORDER',
    ),
    { fields: [], enums: ['AuditType'] },
  );
});

function sources(files: Record<string, string>) {
  return {
    tracked: new Set(Object.keys(files)),
    aliases: [],
    load: async (path: string) =>
      files[path] === undefined
        ? undefined
        : {
            lines: files[path].split('\n'),
            index: indexEvidenceSource(path, files[path], { rich: true }),
          },
    references: async (symbol: string, paths = Object.keys(files)) =>
      paths.flatMap((path) =>
        (files[path] ?? '')
          .split('\n')
          .flatMap((line, i) => (line.includes(symbol) ? [{ path, line: i + 1 }] : [])),
      ),
  };
}

test('follows preparation guards, returned-object methods and aliased lookup definitions before unrelated calls', async () => {
  const files = {
    'flow.ts': [
      "import { Store } from './store';",
      "import { Snapshot } from './model';",
      "import { Noise } from './noise';",
      'export class Flow {',
      '  constructor(private store: Store, private noise: Noise) {}',
      '  createRevision(id) {',
      ...Array.from({ length: 8 }, (_, i) => `    this.noise.record${i}();`),
      '    const entry = this.prepare(id);',
      '    return this.store.add({ stage: Stage.REVISING, entry });',
      '  }',
      '  prepare(id) { return this.inspect(new Snapshot(id)); }',
      '  inspect(snapshot) {',
      '    if (snapshot.stage !== Stage.CLOSED) throw Error();',
      '    return snapshot.latestEntry();',
      '  }',
      '}',
    ].join('\n'),
    'store.ts':
      "import { states as mapping } from './barrel';\nexport class Store {\n add(data: {stage: Stage}) { return db.insert({ status: mapping[data.stage], entry: data.entry }); }\n}",
    'barrel.ts': "export { entryStates as states } from './mapping';",
    'mapping.ts':
      'export const entryStates = { [Stage.REVISING]: Status.OPEN, [Stage.CLOSED]: Status.CLOSED };',
    'model.ts':
      'export class Snapshot {\n latestEntry() { return this.entries.sort((a, b) => b.sequence - a.sequence)[0]; }\n}',
    'noise.ts': `export class Noise {\n${Array.from({ length: 8 }, (_, i) => ` record${i}() {\n${'log("irrelevant");\n'.repeat(300)}}`).join('\n')}\n}`,
  };
  const packet = await collectStateEvidence(sources(files), [finding], 'Stage.CLOSED');
  assert.match(packet, /inspect[^]*if \(snapshot.stage !== Stage.CLOSED\)/);
  assert.match(packet, /latestEntry[^]*b.sequence - a.sequence/);
  assert.match(packet, /mapping.ts[^]*\[Stage.REVISING\]: Status.OPEN/);
  assert.ok(
    packet.indexOf('mapping.ts:') < packet.indexOf('noise.ts:') || !packet.includes('noise.ts:'),
  );
  assert.ok(Buffer.byteLength(packet) <= 16 * 1024);
  const supplied = '### mapping.ts:1\n1: ' + files['mapping.ts'];
  const deduplicated = await collectStateEvidence(
    sources(files),
    [finding],
    'Stage.CLOSED\n' + supplied,
  );
  assert.doesNotMatch(deduplicated, /### mapping.ts:/);
  assert.match(deduplicated, /mapping\[data.stage\]/);
});

test('retrieves registered exception handlers while excluding an unregistered class and a fake registration string', async () => {
  for (const registration of [
    'export function setup(app) { app.useGlobalFilters(new DomainFilter()); }',
    'export const providers = [{ provide: APP_FILTER, useClass: DomainFilter }];',
  ]) {
    const files = {
      'setup.ts': `import { DomainFilter } from './filter';\n${registration}`,
      'filter.ts':
        '@Catch(DomainError)\nexport class DomainFilter { catch(error) { return typedResponse(error); } }',
      'unused.ts':
        '@Catch()\nexport class EverythingFilter { catch(error) { return hide(error); } }',
      'fake.ts': 'const example = "app.useGlobalFilters(new EverythingFilter())";',
      'fake-provider.ts':
        "import { EverythingFilter } from './unused';\nexport const providers = [{ provide: 'APP_FILTER', useClass: EverythingFilter }];",
    };
    const packet = await collectStateEvidence(
      sources(files),
      [{ ...finding, body: 'A raw constraint violation escapes the write.' }],
      '',
    );
    assert.match(packet, /setup.ts/);
    assert.match(packet, /@Catch\(DomainError\)/);
    assert.match(packet, /typedResponse/);
    assert.doesNotMatch(packet, /EverythingFilter|hide\(error\)|fake.ts|fake-provider/);
  }
});

test('reports an ambiguous receiver and terminates cyclic re-exports without treating either as resolved', async () => {
  const packet = await collectStateEvidence(
    sources({
      'flow.ts':
        "import { First } from './a';\nimport { Second } from './b';\nimport { mapping } from './cycle';\nexport function create(value) { return { stage: Stage.REVISING, entry: value.latestEntry(), status: mapping[Stage.REVISING] }; }",
      'a.ts': 'export class First { latestEntry() { return wrongFirst(); } }',
      'b.ts': 'export class Second { latestEntry() { return wrongSecond(); } }',
      'cycle.ts': "export { mapping } from './cycle2';",
      'cycle2.ts': "export { mapping } from './cycle';",
    }),
    [finding],
    'Stage.CLOSED',
  );
  assert.match(packet, /latestEntry \(ambiguous receiver\)/);
  assert.match(packet, /mapping \(definition unavailable\)/);
  assert.doesNotMatch(packet, /wrongFirst|wrongSecond/);
  assert.ok(Buffer.byteLength(packet) <= 16 * 1024);
});

test('retains partial retrieval with explicit omissions under provider failures and large candidate pools', async () => {
  const text =
    'export function create(){\n const data = {stage: Stage.REVISING};\n' +
    'x();\n'.repeat(1200) +
    ';\n return data;\n}';
  const source = {
    lines: text.split('\n'),
    index: indexEvidenceSource('a.ts', text, { rich: true }),
  };
  const paths = Array.from({ length: 60 }, (_, i) => `a${String(i).padStart(2, '0')}.ts`);
  const packet = await collectStateEvidence(
    {
      tracked: new Set(paths),
      aliases: [],
      references: async () => paths.map((path) => ({ path, line: 2 })),
      load: async (path) => {
        if (path === 'a20.ts') throw Error('deadline');
        return source;
      },
    },
    [finding],
    'Stage.CLOSED',
  );
  assert.ok(Buffer.byteLength(packet) <= 16 * 1024);
  assert.match(packet, /stage: Stage.REVISING/);
  assert.match(packet, /Retrieval was incomplete/);
  assert.match(packet, /Omitted candidates: [1-9]/);
});

test('requires complete source-valid proof and rejects enum-only producers, stale quotes, path escapes and malformed proof', async (t) => {
  const { workspace, files } = await fixture(t);
  const evidence = new VerificationEvidence(workspace);
  assert.equal((await evidence.check(confirmed, finding)).verdict, 'confirmed');
  const supplied =
    `### producer.ts:6\n6: ${proof.producer[0].quote}\n` +
    `### delete.ts:2-3\n2: ${proof.guard[0].quote}\n3: ${proof.effect[0].quote}`;
  assert.equal((await evidence.check(confirmed, finding, supplied)).verdict, 'confirmed');
  for (const context of [
    '',
    'No supplied source',
    supplied.replace('6:', '16:'),
    supplied.replace('### producer.ts:6', 'producer.ts\n### other.ts:6'),
  ])
    assert.equal((await evidence.check(confirmed, finding, context)).verdict, 'uncertain');
  for (const candidate of [
    { ...confirmed, proof: undefined },
    {
      ...confirmed,
      proof: { ...proof, producer: [{ path: 'state.ts', line: 1, quote: files['state.ts'] }] },
    },
    {
      ...confirmed,
      proof: {
        ...proof,
        producer: [{ ...proof.producer[0], quote: 'return this.repo.delete({ id });' }],
      },
    },
    {
      ...confirmed,
      proof: { ...proof, producer: [{ ...proof.producer[0], path: '../producer.ts' }] },
    },
    { ...confirmed, proof: { ...proof, trigger: '' } },
  ])
    assert.equal((await evidence.check(candidate, finding)).verdict, 'uncertain');
  assert.equal(
    checkVerificationProof(
      { ...confirmed, proof: undefined },
      { kind: 'docs' },
      new Map(),
      new Set(),
    ).verdict,
    'confirmed',
  );
  assert.equal(
    (await evidence.check({ ...confirmed, verdict: 'refuted', proof: undefined }, finding)).verdict,
    'refuted',
  );
  await writeFile(
    join(workspace, 'producer.ts'),
    files['producer.ts'].replace('Stage.REVISING', 'Stage.CLOSED'),
  );
  assert.equal((await evidence.check(confirmed, finding)).verdict, 'uncertain');
  const outside = `${workspace}-outside.ts`;
  await writeFile(outside, files['producer.ts']);
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(workspace, 'escape.ts'));
  execFileSync('git', ['add', 'escape.ts'], { cwd: workspace });
  assert.equal(
    (
      await evidence.check(
        {
          ...confirmed,
          proof: { ...proof, producer: [{ ...proof.producer[0], path: 'escape.ts' }] },
        },
        finding,
      )
    ).verdict,
    'uncertain',
  );
  assert.equal(
    parseVerificationProof({ ...proof, producer: Array(4).fill(proof.producer[0]) }),
    undefined,
  );
  assert.deepEqual(
    parseFindingVerdicts(JSON.stringify({ verdicts: [confirmed] }), 1, () => {})?.[0].proof,
    proof,
  );
});

test('the opt-in pipeline sends producer evidence and rechecks a proofless confirmation without publishing it', async (t) => {
  const { workspace } = await fixture(t);
  const seen: string[] = [];
  const verdicts = await requestFindingVerdicts({
    workspace,
    model: 'test/model',
    prContext: 'Stage.CLOSED',
    targets: [finding],
    verificationProof: true,
    toolLessFirst: true,
    timeoutMs: 300000,
    log: () => {},
    backend: {
      runFindingVerification: async (_model, context, _targets, ...args) => {
        seen.push(String(args.at(-1)));
        assert.match(context, /Verification proof requirement/);
        assert.match(context, /createRevision/);
        return [{ index: 0, verdict: 'confirmed', reason: 'unsupported assurance' }];
      },
    },
  });
  assert.deepEqual(seen, ['single-shot', 'capped']);
  assert.equal(verdicts[0].verdict, 'uncertain');
});
