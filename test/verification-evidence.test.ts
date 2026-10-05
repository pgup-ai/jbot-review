import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EvidenceStore, indexEvidenceSource } from '../src/shared/evidence.ts';
import {
  collectStateEvidence,
  stateEvidenceTerms,
  VerificationEvidence,
} from '../src/shared/verification-evidence.ts';
import {
  applyFindingVerdicts,
  checkVerificationProof,
  mergeVerdictsByLocation,
} from '../src/shared/filter.ts';
import { parseFindingVerdicts } from '../src/shared/opencode.ts';
import {
  parseVerificationProof,
  parseVerificationSupport,
  type Finding,
  type FindingVerdict,
} from '../src/shared/types.ts';
import { requestFindingVerdicts } from '../src/shared/runner.ts';
import { buildFindingSourceContext } from '../src/shared/finding-context.ts';
import {
  assembleFindingVerificationPrompt,
  formatContextPackItem,
  formatStateEvidence,
  STATE_EVIDENCE_OMISSION,
  verifierOmissionNote,
} from '../src/shared/prompt.ts';
import { formatFindingCommentBody } from '../src/shared/github.ts';
import { renderOrphanedSection } from '../src/shared/report.ts';
import { createHash } from 'node:crypto';
import { reviewPromptBudget } from '../src/shared/review-plan.ts';

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
    'read.ts': 'export function inspect(record) {\n  const { stage } = record;\n  return stage;\n}',
    'call.ts': 'export function create(record) {\n  return persist(record);\n}',
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
    { fields: ['stage'], enums: ['RecordStage'] },
  );
  assert.deepEqual(
    stateEvidenceTerms(
      [{ ...finding, body: 'order.type is recorded as AuditType.ORDER.' }],
      'OrderType.EXPENSE UnrelatedType.ORDER',
    ),
    { fields: ['type'], enums: ['AuditType'] },
  );
  for (const member of ['ACTIVE', 'Active', 'X']) {
    const context = `RecordStage.${member} OtherStatus.${member}`;
    for (const state of [`RecordStage.${member}`, member]) {
      const candidate = { ...finding, body: `The record.stage === ${state} guard misses entries.` };
      assert.deepEqual(stateEvidenceTerms([candidate], context), {
        fields: ['stage'],
        enums: ['RecordStage'],
      });
      const source = `export function create() { return { status: RecordStage.${member} }; }`;
      const evidence = await collectStateEvidence(
        sources({ 'producer.ts': source }),
        [candidate],
        context,
      );
      assert.match(evidence, /producer.ts[^]*function create/);
    }
  }
  assert.deepEqual(
    stateEvidenceTerms(
      [{ ...finding, body: 'record.stage === CLOSED returns HttpStatus.OK.' }],
      'Stage.CLOSED',
    ),
    { fields: ['stage'], enums: ['HttpStatus', 'Stage'] },
  );
  const indirect = await collectStateEvidence(
    sources({
      'writer.ts':
        'export function update(record, nextStage) {\n record.stage = nextStage;\n persist(record);\n}',
    }),
    [finding],
    'Stage.CLOSED',
  );
  assert.match(indirect, /record.stage = nextStage/);
  const crowded = await collectStateEvidence(
    sources({
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `a${i}.ts`,
          'export function fail() { throw Error.InvalidState; }',
        ]),
      ),
      'z.ts': 'export function revise(record, next) { record.stage = next; persist(record); }',
    }),
    [{ ...finding, body: 'record.stage can change without Error.InvalidState being thrown.' }],
    '',
  );
  assert.match(crowded, /record.stage = next/);
  const privateSource = await collectStateEvidence(
    sources({
      'producer.ts':
        "import { Repo } from './repo';\nexport class Service {\n #repo: Repo;\n createRevision(id) { this.#assertAllowed(id); return this.#repo.update({ id, stage: Stage.REVISING }); }\n #assertAllowed(id) { if (!id) throw Error(); }\n}",
      'repo.ts': 'export class Repo { update(data) { return db.persist(data); } }',
    }),
    [finding],
    'Stage.CLOSED',
  );
  assert.match(privateSource, /if \(!id\) throw Error/);
  assert.match(privateSource, /db.persist\(data\)/);
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
    'export function setup(app) { app\n .useGlobalFilters(new DomainFilter()); }',
    'export const providers = [{ provide: APP_FILTER, useClass: DomainFilter }];',
    'export const providers = [{ provide:\n APP_FILTER, useClass: DomainFilter }];',
    'import { APP_FILTER as FILTER_TOKEN } from "@nestjs/core";\nexport const providers = [{ provide: FILTER_TOKEN, useClass: DomainFilter }];',
    'import { useGlobalFilters as register } from "./bootstrap";\nexport function setup() { register(new DomainFilter()); }',
    'export const providers = [{ provide: (APP_FILTER as ProviderToken), useClass: DomainFilter }];',
    'import { filter } from "./instance";\nexport function setup(app) { app.useGlobalFilters(filter); }',
    'import { FirstFilter } from "./first";\nexport function setup(app) { app.useGlobalFilters(new FirstFilter()); app.useGlobalFilters(\nnew DomainFilter()); }',
  ]) {
    const files = {
      'setup.ts': `import { DomainFilter } from './filter';\n${registration}`,
      'filter.ts':
        '@Catch(DomainError)\nexport class DomainFilter { catch(error) { return typedResponse(error); } }',
      'instance.ts':
        "import { DomainFilter } from './filter';\nexport const filter = new DomainFilter();",
      'first.ts': 'export class FirstFilter { catch(error) { return error; } }',
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
        if (path === 'a00.ts') throw Error('unreadable file');
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
  const gaps = Array.from({ length: 12 }, (_, i) => ({
    path: `source${i}.ts`,
    line: 1,
    symbol: 'missing',
    reason: 'missing' as const,
  }));
  const omitted = formatStateEvidence([], 0, false, gaps);
  assert.match(omitted, /source7.ts/);
  assert.doesNotMatch(omitted, /source8.ts/);
  assert.match(omitted, /4 further unresolved dependencies omitted/);
});

test('requires complete source-valid proof and rejects enum-only producers, stale quotes, path escapes and malformed proof', async (t) => {
  const { workspace, files } = await fixture(t);
  const evidence = new VerificationEvidence(workspace);
  for (const path of ['delete.py', 'delete.go', 'delete.rs'])
    assert.equal(
      (await evidence.check({ ...confirmed, proof: undefined }, { ...finding, path })).verdict,
      'confirmed',
    );
  assert.equal((await evidence.check(confirmed, finding)).verdict, 'confirmed');
  const supplied =
    `### producer.ts:6\n6: ${proof.producer[0].quote}\n` +
    `### delete.ts:2-3\n2: ${proof.guard[0].quote}\n3: ${proof.effect[0].quote}`;
  assert.equal((await evidence.check(confirmed, finding, supplied)).verdict, 'confirmed');
  assert.equal(
    (
      await evidence.check(
        {
          ...confirmed,
          proof: {
            ...proof,
            producer: [{ path: 'call.ts', line: 2, quote: 'return persist(record);' }],
          },
        },
        finding,
      )
    ).verdict,
    'confirmed',
  );
  const diff = formatContextPackItem({
    path: 'producer.ts',
    rows: [],
    diff: `@@ -6 +6 @@\n-oldProducer();\n+${proof.producer[0].quote}`,
  });
  const diffSource = diff + '\n' + supplied.slice(supplied.indexOf('### delete.ts'));
  assert.equal((await evidence.check(confirmed, finding, diffSource)).verdict, 'confirmed');
  const sourceContext = await buildFindingSourceContext(workspace, [
    { ...finding, body: 'The producer is at `producer.ts:6`.' },
  ]);
  const pack =
    formatContextPackItem({
      path: 'producer.ts',
      rows: [[6, proof.producer[0].quote]],
    }) +
    '\n' +
    supplied.slice(supplied.indexOf('### delete.ts'));
  const state = await evidence.prepare([finding], '', 4000);
  for (const context of [
    sourceContext,
    pack,
    state + '\n' + supplied.slice(supplied.indexOf('### delete.ts')),
  ])
    assert.equal((await evidence.check(confirmed, finding, context)).verdict, 'confirmed');
  assert.equal(
    (
      await evidence.check(
        confirmed,
        finding,
        diffSource.replace(
          `-oldProducer();\n+${proof.producer[0].quote}`,
          `-${proof.producer[0].quote}\n+otherProducer();`,
        ),
      )
    ).verdict,
    'uncertain',
  );
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
      proof: {
        ...proof,
        producer: [{ path: 'read.ts', line: 2, quote: 'const { stage } = record;' }],
      },
    },
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

test('a failed proof source check leaves other verdicts intact', async (t) => {
  const { workspace } = await fixture(t);
  t.mock.method(EvidenceStore.prototype, 'packProvider', async () => {
    throw Error('inventory unavailable');
  });
  const verdicts = await requestFindingVerdicts({
    workspace,
    model: 'test/model',
    prContext: '',
    targets: [finding, finding, { ...finding, kind: 'docs' }],
    sourceContext: async () => '',
    verificationProof: true,
    log: () => {},
    backend: {
      runFindingVerification: async () => [
        confirmed,
        { index: 1, verdict: 'refuted', reason: 'counterexample' },
        { index: 2, verdict: 'confirmed', reason: 'documented behavior' },
      ],
    },
  });
  assert.deepEqual(
    verdicts.map((v) => v.verdict),
    ['uncertain', 'refuted', 'confirmed'],
  );
  assert.equal(verdicts[0].unavailable, true);
  assert.equal(verdicts[1].reason, 'counterexample');
  for (const verificationRetrieval of [false, true]) {
    const targetFailure = await requestFindingVerdicts({
      verificationRetrieval,
      workspace,
      model: 'test/model',
      prContext: '',
      targets: [finding, { ...finding, path: 'other.ts' }],
      sourceContext: async (targets) => {
        if (targets.length === 1 && targets[0] === finding) throw Error('source unavailable');
        return proof.producer[0].quote;
      },
      log: () => {},
      backend: {
        runFindingVerification: async () => [
          {
            ...confirmed,
            finding: {
              title: finding.title,
              kind: 'bug',
              severity: 'P2',
              evidence: proof.producer[0].quote,
            },
          },
          { index: 1, verdict: 'refuted', reason: 'counterexample' },
        ],
      },
    });
    assert.deepEqual(
      targetFailure.map((v) => v.verdict),
      ['uncertain', 'refuted'],
    );
    assert.equal(targetFailure[0].unavailable, true);
  }
});

test('revision lookup failures preserve unavailable status instead of claiming missing proof', async (t) => {
  const { workspace } = await fixture(t);
  const evidence = new VerificationEvidence(workspace);
  assert.equal((await evidence.check(confirmed, finding)).verdict, 'confirmed');
  await rename(join(workspace, '.git'), join(workspace, 'hidden-git'));
  for (const validator of [evidence, new VerificationEvidence(workspace)]) {
    const verdict = await validator.check(confirmed, finding);
    assert.equal(verdict.verdict, 'uncertain');
    assert.equal(verdict.unavailable, true);
    assert.match(verdict.reason!, /validation did not complete/);
  }
});

test('distinguishes unsupported producer indexing from invalid source proof', async (t) => {
  const { workspace } = await fixture(t);
  const files = {
    'migration.sql': "UPDATE events SET stage = 'revising';",
    'state.json': '{ "stage": "revising" }',
    'large.ts': 'record.stage = Stage.REVISING;\n' + '// padding\n'.repeat(100_000),
    'unsupported.ts': 'record.stage = Stage.REVISING;\nunsupported syntax @@@',
  };
  for (const [path, source] of Object.entries(files))
    await writeFile(join(workspace, path), source);
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const evidence = new VerificationEvidence(workspace);
  for (const [path, source] of Object.entries(files)) {
    const producer = { path, line: 1, quote: source.split('\n')[0] };
    const candidate = { ...confirmed, proof: { ...proof, producer: [producer] } };
    const supplied = [producer, ...proof.guard, ...proof.effect]
      .map((ref) => formatContextPackItem({ path: ref.path, rows: [[ref.line, ref.quote]] }))
      .join('\n');
    const verdict = await evidence.check(candidate, finding, supplied);
    assert.equal(verdict.verdict, 'uncertain', path);
    assert.equal(verdict.unavailable, true, path);
    const applied = applyFindingVerdicts([finding], [0], [verdict]).findings[0];
    assert.equal(applied.verificationUnavailable, true);
    assert.equal(applied.publishUnverified, 'P2');
    for (const invalid of [
      {
        ...candidate,
        proof: { ...candidate.proof, guard: [{ ...proof.guard[0], quote: 'stale' }] },
      },
      {
        ...candidate,
        proof: {
          ...candidate.proof,
          producer: [producer, { path: 'read.ts', line: 2, quote: 'const { stage } = record;' }],
        },
      },
    ]) {
      const rejected = await evidence.check(invalid, finding);
      assert.equal(rejected.verdict, 'uncertain');
      assert.notEqual(rejected.unavailable, true);
    }
  }
});

test('the proof gate follows the kind retained by verdict application', async (t) => {
  const { workspace } = await fixture(t);
  for (const [kind, correctedKind, unresolved, expected] of [
    ['docs', 'bug', true, 'uncertain'],
    ['maintainability', 'bug', true, 'uncertain'],
    ['docs', 'bug', false, 'confirmed'],
    ['bug', 'docs', false, 'uncertain'],
    ['security', 'maintainability', false, 'uncertain'],
    ['bug', 'docs', true, 'confirmed'],
  ] as const) {
    const target = { ...finding, kind, verificationUncertain: unresolved };
    const verdict: FindingVerdict = {
      ...confirmed,
      proof: undefined,
      finding: {
        title: finding.title,
        kind: correctedKind,
        severity: 'P2',
        evidence: proof.producer[0].quote,
      },
    };
    const result = await requestFindingVerdicts({
      workspace,
      model: 'test/model',
      prContext: '',
      targets: [target],
      sourceContext: async () => proof.producer[0].quote,
      verificationProof: true,
      log: () => {},
      backend: { runFindingVerification: async () => [verdict] },
    });
    assert.equal(result[0].verdict, expected, `${kind} -> ${correctedKind}, ${unresolved}`);
    assert.equal(checkVerificationProof(verdict, target, new Map(), new Set()).verdict, expected);
    const applied = applyFindingVerdicts([target], [0], result).findings[0];
    assert.equal(applied.verificationUncertain === true, expected === 'uncertain');
    if (expected === 'confirmed') assert.equal(applied.kind, unresolved ? correctedKind : kind);
    assert.equal(
      (await new VerificationEvidence(workspace).check({ ...verdict, proof }, target)).verdict,
      'confirmed',
    );
  }
});

test('a corrected finding keeps its retrieved evidence without borrowing another target’s packet', async (t) => {
  const { workspace } = await fixture(t);
  let answered = false;
  let active = 0;
  let maxActive = 0;
  const prepare = VerificationEvidence.prototype.prepare;
  t.mock.method(VerificationEvidence.prototype, 'prepare', async function (...args) {
    assert.equal(answered, false, 'Validate against delivered evidence, without another retrieval');
    maxActive = Math.max(maxActive, ++active);
    try {
      return await prepare.apply(this, args);
    } finally {
      active--;
    }
  });
  const verdicts = await requestFindingVerdicts({
    workspace,
    model: 'test/model',
    prContext: 'Stage.CLOSED',
    targets: [
      finding,
      { ...finding, kind: 'docs' },
      { ...finding, kind: 'maintainability', verificationUncertain: true },
    ],
    sourceContext: async () => '',
    verificationRetrieval: true,
    verificationProof: true,
    log: () => {},
    backend: {
      runFindingVerification: async () => {
        answered = true;
        return [0, 1, 2].map((index) => ({
          ...confirmed,
          index,
          finding: {
            title: finding.title,
            kind: 'bug' as const,
            severity: 'P2' as const,
            evidence: proof.producer[0].quote,
          },
        }));
      },
    },
  });
  assert.deepEqual(
    verdicts.map((v) => v.verdict),
    ['confirmed', 'uncertain', 'confirmed'],
  );
  assert.equal(maxActive, 3, 'Per-target retrieval shares one deadline concurrently');
});

test('a full prompt still discloses omitted state evidence', async (t) => {
  const { workspace } = await fixture(t);
  const prContext = 'Stage.CLOSED';
  const targets = [finding];
  const transportBytes = Buffer.byteLength(
    assembleFindingVerificationPrompt(
      [prContext, verifierOmissionNote(1), STATE_EVIDENCE_OMISSION].join('\n\n'),
      targets,
    ),
  );
  let called = false;
  const verdicts = await requestFindingVerdicts({
    workspace,
    model: 'test/model',
    prContext,
    targets,
    sourceContext: async () => '',
    verificationRetrieval: true,
    promptBudget: { ...reviewPromptBudget('test'), transportBytes },
    verificationContextFor: () => ({ packs: ['OPTIONAL_PACK'], rules: [] }),
    log: () => {},
    backend: {
      runFindingVerification: async (_model, context, findings) => {
        called = true;
        assert.match(context, /State-producing source candidates omitted/);
        assert.match(context, /1 supporting excerpt/);
        assert.doesNotMatch(context, /OPTIONAL_PACK|### producer.ts/);
        assert.ok(
          Buffer.byteLength(assembleFindingVerificationPrompt(context, findings)) <= transportBytes,
        );
        return [{ index: 0, verdict: 'uncertain' }];
      },
    },
  });
  assert.equal(called, true);
  assert.equal(verdicts[0].verdict, 'uncertain');
});

test('retrieval and proof enforcement are independent and only proof enforcement rechecks a proofless confirmation', async (t) => {
  const { workspace } = await fixture(t);
  for (const verificationRetrieval of [false, true]) {
    for (const verificationProof of [false, true]) {
      const seen: string[] = [];
      const verdicts = await requestFindingVerdicts({
        workspace,
        model: 'test/model',
        prContext: 'Stage.CLOSED',
        targets: [finding],
        verificationRetrieval,
        verificationProof,
        toolLessFirst: true,
        timeoutMs: 300000,
        log: () => {},
        backend: {
          runFindingVerification: async (_model, context, _targets, ...args) => {
            seen.push(String(args[4]));
            assert.equal(args[5], verificationProof);
            assert.doesNotMatch(context, /Verification proof requirement/);
            assert.equal(context.includes('createRevision'), verificationRetrieval);
            return [{ index: 0, verdict: 'confirmed', reason: 'unsupported assurance' }];
          },
        },
      });
      assert.deepEqual(seen, verificationProof ? ['single-shot', 'capped'] : ['single-shot']);
      assert.equal(verdicts[0].verdict, verificationProof ? 'uncertain' : 'confirmed');
    }
  }
});

test('validates accepted tool-less proofs once while checking remaining targets', async (t) => {
  const { workspace } = await fixture(t);
  const check = t.mock.method(VerificationEvidence.prototype, 'check');
  const modes: string[] = [];
  const verdicts = await requestFindingVerdicts({
    workspace,
    model: 'test/model',
    prContext: 'Stage.CLOSED',
    targets: [finding, { ...finding, title: 'Another concern' }],
    verificationRetrieval: true,
    verificationProof: true,
    toolLessFirst: true,
    log: () => {},
    backend: {
      runFindingVerification: async (_model, _context, targets, ...args) => {
        const mode = String(args[4]);
        modes.push(mode);
        assert.equal(targets.length, mode === 'single-shot' ? 2 : 1);
        return mode === 'single-shot'
          ? [confirmed, { index: 1, verdict: 'uncertain' }]
          : [confirmed];
      },
    },
  });
  assert.deepEqual(modes, ['single-shot', 'capped']);
  assert.deepEqual(
    verdicts.map((v) => [v.index, v.verdict]),
    [
      [0, 'confirmed'],
      [1, 'confirmed'],
    ],
  );
  assert.deepEqual(
    check.mock.calls.map(({ arguments: [verdict, , supplied] }) => [
      verdict.index,
      verdict.verdict,
      supplied !== undefined,
    ]),
    [
      [0, 'confirmed', true],
      [1, 'uncertain', true],
      [1, 'confirmed', false],
    ],
  );
});

const support = {
  explanation:
    'Creating a revision changes the stage but retains the link. The stage guard allows deletion, which removes that link.',
  references: [...proof.producer, ...proof.guard, ...proof.effect],
};

test('optional support parser bounds untrusted data and never accepts driver provenance', () => {
  assert.deepEqual(parseVerificationSupport(support), support);
  for (const malformed of [
    null,
    {},
    { ...support, explanation: '字'.repeat(801) },
    { ...support, references: [] },
    { ...support, references: Array(7).fill(proof.guard[0]) },
    ...['../secret.ts', '/secret.ts', '.git/config', 'a/../secret.ts'].map((path) => ({
      ...support,
      references: [{ ...proof.guard[0], path }],
    })),
    { ...support, references: [{ ...proof.guard[0], line: 1.5 }] },
    { ...support, references: [{ ...proof.guard[0], quote: 'line one\nline two' }] },
  ])
    assert.equal(parseVerificationSupport(malformed), undefined);
  const parsed = parseFindingVerdicts(
    JSON.stringify({
      verdicts: [{ ...confirmed, support, verifiedSupport: { target: 'forged' } }],
    }),
    1,
    () => {},
  )![0];
  assert.deepEqual(parsed.support, support);
  assert.equal(parsed.verifiedSupport, undefined);
  for (const verdict of ['refuted', 'uncertain'])
    assert.equal(
      parseFindingVerdicts(
        JSON.stringify({ verdicts: [{ index: 0, verdict, support }] }),
        1,
        () => {},
      )![0].support,
      undefined,
    );
});

test('support source validation fails open for stale, untracked, symlink and changed-revision evidence', async (t) => {
  const { workspace, files } = await fixture(t);
  const evidence = new VerificationEvidence(workspace);
  const input = { ...confirmed, support };
  const valid = await evidence.support(input, finding);
  assert.equal(
    valid.verifiedSupport!.revision,
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
  );
  assert.equal(
    valid.verifiedSupport!.sourceHashes['delete.ts'],
    createHash('sha256').update(files['delete.ts']).digest('hex'),
  );
  await writeFile(join(workspace, 'untracked.ts'), files['delete.ts']);
  await symlink(join(workspace, 'delete.ts'), join(workspace, 'linked.ts'));
  execFileSync('git', ['add', 'linked.ts'], { cwd: workspace });
  for (const references of [
    [{ ...proof.guard[0], quote: 'invented source line' }],
    [{ ...proof.guard[0], line: 900 }],
    [{ ...proof.guard[0], path: 'untracked.ts' }],
    [{ ...proof.guard[0], path: 'linked.ts' }],
    [{ ...proof.guard[0], path: '../delete.ts' }],
  ]) {
    const candidate = { ...input, support: { ...support, references } };
    assert.deepEqual(await evidence.support(candidate, finding), candidate);
  }
  assert.equal((await evidence.support(input, finding, '')).verifiedSupport, undefined);
  const supplied = await buildFindingSourceContext(workspace, [finding]);
  const guardOnly = { ...input, support: { ...support, references: proof.guard } };
  assert.ok((await evidence.support(guardOnly, finding, supplied)).verifiedSupport);
  await writeFile(
    join(workspace, 'delete.ts'),
    files['delete.ts'].replace('Stage.CLOSED', 'Stage.OTHER'),
  );
  assert.equal((await evidence.support(input, finding)).verifiedSupport, undefined);
  await writeFile(join(workspace, 'delete.ts'), files['delete.ts']);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'next',
    ],
    { cwd: workspace },
  );
  assert.deepEqual(await evidence.support(input, finding), input);
  assert.deepEqual(await new VerificationEvidence('/missing').support(input, finding), input);
});

test('validated support survives both finding handoffs and public rendering without replacing the claim', async (t) => {
  const { workspace } = await fixture(t);
  const verdict = await new VerificationEvidence(workspace).support(
    { ...confirmed, support },
    finding,
  );
  for (const result of [
    applyFindingVerdicts([finding], [0], [verdict]),
    mergeVerdictsByLocation([finding], [finding], [verdict]),
  ]) {
    const delivered = result.findings[0];
    assert.ok(delivered.body.startsWith(finding.body + '\n\n'));
    assert.ok(delivered.body.includes(support.explanation));
    assert.equal(delivered.path, finding.path);
    assert.equal(delivered.line, finding.line);
    assert.equal(delivered.severity, finding.severity);
    assert.ok(delivered.body.includes(verdict.verifiedSupport!.sourceHashes['producer.ts']));
    const comment = formatFindingCommentBody(delivered);
    assert.ok(comment.includes(support.explanation));
    assert.ok(comment.endsWith('<!-- jbot-review:finding -->'));
    assert.ok(renderOrphanedSection([delivered]).join('\n').includes(support.explanation));
  }
  const changed = { ...finding, body: 'A different claim at the same location' };
  assert.deepEqual(mergeVerdictsByLocation([changed], [finding], [verdict]).findings, [changed]);
  assert.deepEqual(applyFindingVerdicts([finding], [0], [{ ...confirmed, support }]).findings, [
    finding,
  ]);
  for (const status of ['refuted', 'uncertain'] as const) {
    const result = applyFindingVerdicts([finding], [0], [{ ...verdict, verdict: status }]);
    assert.ok(!result.findings.some((f) => f.body.includes(support.explanation)));
  }
});

test('runner requests support only when opted in and remaps capped re-check support to its target', async (t) => {
  const { workspace } = await fixture(t);
  const targets = [finding, { ...finding, title: 'Second concern' }];
  for (const enabled of [false, true]) {
    const calls: string[] = [];
    const verdicts = await requestFindingVerdicts({
      workspace,
      model: 'test/model',
      prContext: '',
      targets,
      verificationSupport: enabled,
      sourceContext: async () => '',
      toolLessFirst: true,
      log: () => {},
      backend: {
        runFindingVerification: async (
          _model,
          context,
          batch,
          _log,
          _timeout,
          _usage,
          _options,
          mode,
        ) => {
          assert.equal(context.includes('## Optional verification support'), enabled);
          calls.push(mode!);
          return mode === 'single-shot'
            ? [
                { index: 0, verdict: 'confirmed', support },
                { index: 1, verdict: 'uncertain' },
              ]
            : batch.map((_, index) => ({ index, verdict: 'confirmed', support }));
        },
      },
    });
    assert.deepEqual(calls, ['single-shot', 'capped']);
    assert.equal(
      verdicts[0].verifiedSupport,
      undefined,
      'unseen source cannot back tool-less support',
    );
    assert.equal(!!verdicts[1].verifiedSupport, enabled);
    const delivered = applyFindingVerdicts(targets, [0, 1], verdicts).findings;
    assert.equal(delivered[0].body, finding.body);
    assert.equal(delivered[1].body.includes(support.explanation), enabled);
  }
});
