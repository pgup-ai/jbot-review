import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRuleChecks,
  ruleCheckAgreement,
  ruleCheckFinding,
  runRuleChecks,
  validateCompiledChecks,
} from '../src/shared/rule-checks.ts';
import type { Finding } from '../src/shared/types.ts';

const check = {
  id: 'tests-use-create-test',
  rule: '`TESTING.md` §2: "Build fixtures with createTestXyz helpers."',
  severity: 'P2',
  title: 'Fixture built by hand',
  files: ['*.spec.ts'],
  pattern: 'new \\w+Entity\\(',
  unless: 'createTest',
  mode: 'shadow',
};

test('parseRuleChecks keeps valid checks and rejects malformed or duplicate ones by id', () => {
  const { checks, rejected } = parseRuleChecks(
    JSON.stringify({
      checks: [
        check,
        { ...check },
        { ...check, id: 'bad-regex', pattern: '(' },
        { ...check, id: 'bad-mode', mode: 'block' },
        { ...check, id: 'no-files', files: [] },
        { ...check, id: 'Upper' },
        'not a check',
      ],
    }),
  );
  assert.deepEqual(
    checks.map((c) => c.id),
    ['tests-use-create-test'],
  );
  assert.deepEqual(rejected, [
    'tests-use-create-test',
    'bad-regex',
    'bad-mode',
    'no-files',
    'Upper',
    '#6',
  ]);
  assert.deepEqual(
    parseRuleChecks(
      JSON.stringify({
        checks: Array.from({ length: 201 }, (_, i) => ({ ...check, id: `c${i}` })),
      }),
    ).rejected,
    ['c200'],
  );
  assert.throws(() => parseRuleChecks('{"rules":[]}'), /"checks" array/);
});

test('runRuleChecks matches added lines in scoped files only and honours unless', () => {
  const { checks } = parseRuleChecks(JSON.stringify({ checks: [check] }));
  const patch = [
    '@@ -1,2 +1,4 @@',
    ' const a = new UserEntity();',
    '+const b = new OrderEntity();',
    '+const c = createTestOrder(new OrderEntity());',
    '-const d = new GoneEntity();',
    '+const e = 1;',
  ].join('\n');
  const hits = runRuleChecks(checks, [
    { filename: 'src/order.spec.ts', patch },
    { filename: 'src/order.ts', patch },
    { filename: 'src/empty.spec.ts' },
  ]);
  assert.deepEqual(
    hits?.map(({ path, line }) => ({ path, line })),
    [{ path: 'src/order.spec.ts', line: 2 }],
  );
  assert.match(ruleCheckFinding(hits![0]).body, /createTestXyz[\s\S]*`tests-use-create-test`/);
});

test('runRuleChecks matches past any line length and gives up on catastrophic backtracking', () => {
  const parse = (pattern: string) =>
    parseRuleChecks(JSON.stringify({ checks: [{ ...check, pattern, unless: undefined }] })).checks;
  const patch = (line: string) => [{ filename: 'a.spec.ts', patch: `@@ -0,0 +1 @@\n+${line}` }];
  assert.equal(
    runRuleChecks(parse('it\\.only\\('), patch(`${' '.repeat(5000)}it.only(`))?.length,
    1,
  );
  assert.equal(runRuleChecks(parse('^(a+)+$'), patch(`${'a'.repeat(40)}!`), 50), undefined);
});

test('ruleCheckAgreement reports every shadow check and findings it misses in covered files', () => {
  const { checks } = parseRuleChecks(
    JSON.stringify({ checks: [check, { ...check, id: 'quiet', files: ['*.md'] }] }),
  );
  const hits = [10, 40].map((line) => ({ check: checks[0], path: 'a.spec.ts', line }));
  const finding = (path: string, line: number) => ({ path, line }) as Finding;
  assert.deepEqual(
    ruleCheckAgreement(
      checks,
      [...hits, { check: checks[0], path: 'skipped.spec.ts', line: 1 }],
      [
        finding('a.spec.ts', 12),
        finding('a.spec.ts', 90),
        finding('b.spec.ts', 5),
        finding('b.ts', 1),
      ],
      new Set(['a.spec.ts', 'b.spec.ts', 'b.ts']),
    ),
    {
      checks: { 'tests-use-create-test': { hits: 2, agreed: 1 }, quiet: { hits: 0, agreed: 0 } },
      unexplained: 2,
    },
  );
});

test('validateCompiledChecks keeps verbatim, example-consistent checks in shadow and reports existing hits', () => {
  const docs = ['## Tests\n\nBuild fixtures with createTestXyz   helpers.\n'];
  const candidate = (id: string, extra: Record<string, unknown> = {}) => ({
    ...check,
    id,
    mode: 'enforce',
    ...extra,
  });
  const { checks, report } = validateCompiledChecks(
    JSON.stringify({
      checks: [
        candidate('kept'),
        candidate('invented', { rule: '`TESTING.md`: "Never construct entities in tests."' }),
        candidate('too-broad', { pattern: 'Entity' }),
        { id: 'broken' },
      ],
    }),
    {
      docs,
      repoFiles: [{ path: 'old.spec.ts', text: 'const a = new UserEntity();\nconst b = 1;' }],
      examples: [
        { check: 'kept', path: 'x.spec.ts', text: 'new OrderEntity()', violation: true },
        {
          check: 'too-broad',
          path: 'x.spec.ts',
          text: 'const order: OrderEntity = load();',
          violation: false,
        },
      ],
    },
  );
  assert.deepEqual(
    checks.map((c) => [c.id, c.mode, c.pattern]),
    [['kept', 'shadow', 'new \\w+Entity\\(']],
  );
  assert.deepEqual(
    report.map(({ id, kept, reason, existingHits }) => ({ id, kept, reason, existingHits })),
    [
      { id: 'broken', kept: false, reason: 'malformed-or-duplicate', existingHits: 0 },
      { id: 'kept', kept: true, reason: undefined, existingHits: 1 },
      { id: 'invented', kept: false, reason: 'rule-not-quoted-verbatim', existingHits: 1 },
      { id: 'too-broad', kept: false, reason: 'disagrees-with-examples', existingHits: 1 },
    ],
  );
});
