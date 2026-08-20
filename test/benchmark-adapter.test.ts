import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessCompetitorComparability,
  normalizeCompetitorFindings,
  type CompetitorModelConfiguration,
} from '../src/shared/benchmark-adapter.ts';

const configuration: CompetitorModelConfiguration = {
  model: 'provider/model',
  modelRevision: 'revision-1',
  endpoint: 'sha256:endpoint',
  reasoningEffort: 'medium',
  sampling: { temperature: 0 },
};

describe('competitor benchmark adapters', () => {
  it('normalizes GitHub review comments without changing their finding fields', () => {
    assert.deepEqual(
      normalizeCompetitorFindings('github-review', [
        { id: 'comment-1', path: 'src/a.ts', line: 4, severity: 'P2', title: 'Contract break' },
      ]),
      [
        {
          fingerprint: 'comment-1',
          path: 'src/a.ts',
          line: 4,
          severity: 'P2',
          title: 'Contract break',
        },
      ],
    );
    assert.deepEqual(
      normalizeCompetitorFindings('github-review', [
        {
          id: 2,
          path: 'src/b.ts',
          line: 7,
          severity: 'warning',
          title: 'Raw warning',
        },
        {
          id: 3,
          path: 'src/c.ts',
          original_line: 9,
          body: '**P1 · bug** (*conf: high*) — Parsed from the comment body\n\nDetails',
        },
        {
          id: 4,
          path: 'src/d.ts',
          line: null,
          original_line: null,
          body: '**P3** — File-level note',
        },
      ]),
      [
        { fingerprint: '2', path: 'src/b.ts', line: 7, severity: 'P2', title: 'Raw warning' },
        {
          fingerprint: '3',
          path: 'src/c.ts',
          line: 9,
          severity: 'P1',
          title: 'Parsed from the comment body',
        },
        {
          fingerprint: '4',
          path: 'src/d.ts',
          line: 0,
          severity: 'P3',
          title: 'File-level note',
        },
      ],
    );
    const finding = { path: 'src/a.ts', line: 4, severity: 'P2', title: 'Contract break' };
    assert.deepEqual(normalizeCompetitorFindings('benchmark-json', { findings: [finding] }), [
      finding,
    ]);
    assert.deepEqual(
      normalizeCompetitorFindings('sarif', {
        runs: [
          {
            results: [
              {
                ruleId: 'contract',
                level: 'warning',
                message: { text: 'Contract break' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/a.ts' },
                      region: { startLine: 4 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      [{ ...finding, anchored: true, fingerprint: 'contract:src/a.ts:4:Contract break' }],
    );
    assert.deepEqual(
      normalizeCompetitorFindings('sarif', {
        runs: [{ results: [{ ruleId: 'global', level: 'warning', message: { text: 'Global' } }] }],
      }),
      [
        {
          path: '',
          line: 0,
          severity: 'P2',
          title: 'Global',
          anchored: false,
          fingerprint: 'global::0:Global',
        },
      ],
    );
    assert.deepEqual(
      normalizeCompetitorFindings(
        'sarif',
        {
          runs: [
            {
              originalUriBaseIds: { SRCROOT: { uri: 'file:///workspace/' } },
              results: [
                {
                  ruleId: 'encoded-path',
                  level: 'warning',
                  message: { text: 'Encoded path' },
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: 'src/a%20b.ts', uriBaseId: 'SRCROOT' },
                        region: { startLine: 4 },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        { repositoryRoot: '/workspace' },
      )[0].path,
      'src/a b.ts',
    );
    const repeatedRule = normalizeCompetitorFindings('sarif', {
      runs: [
        {
          results: [4, 8].map((startLine) => ({
            ruleId: 'contract',
            level: 'warning',
            message: { text: 'Contract break' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/a.ts' },
                  region: { startLine },
                },
              },
            ],
          })),
        },
      ],
    });
    assert.notEqual(repeatedRule[0].fingerprint, repeatedRule[1].fingerprint);
    assert.deepEqual(
      normalizeCompetitorFindings('sarif', {
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  {
                    id: 'contract',
                    defaultConfiguration: { level: 'error' },
                    messageStrings: { primary: { text: 'Rule message' } },
                  },
                ],
                globalMessageStrings: { global: { text: 'Global message' } },
              },
            },
            artifacts: [{ location: { uri: 'src/indexed.ts' } }],
            results: [
              {
                ruleIndex: 0,
                message: { id: 'primary' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { index: 0 },
                      region: { startLine: 6 },
                    },
                  },
                ],
              },
              { level: 'note', message: { id: 'global' } },
              { kind: 'pass', message: { text: 'Not a finding' } },
            ],
          },
        ],
      }).map(({ title, severity, path }) => ({ title, severity, path })),
      [
        { title: 'Rule message', severity: 'P1', path: 'src/indexed.ts' },
        { title: 'Global message', severity: 'P3', path: '' },
      ],
    );
  });

  it('resolves nested SARIF URI bases and rejects invalid paths', () => {
    const result = (uriBaseId: string) => ({
      ruleId: uriBaseId,
      level: 'warning',
      message: { text: uriBaseId },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'a.ts', uriBaseId },
            region: { startLine: 1 },
          },
        },
      ],
    });
    const findings = normalizeCompetitorFindings(
      'sarif',
      {
        runs: [
          {
            originalUriBaseIds: {
              ROOT: { uri: 'file:///workspace/' },
              SRC: { uri: 'src/', uriBaseId: 'ROOT' },
              CYCLE_A: { uri: 'a/', uriBaseId: 'CYCLE_B' },
              CYCLE_B: { uri: 'b/', uriBaseId: 'CYCLE_A' },
              MALFORMED: { uri: 'not a URL' },
            },
            results: [result('SRC'), result('MISSING'), result('CYCLE_A'), result('MALFORMED')],
          },
        ],
      },
      { repositoryRoot: '/workspace' },
    );
    assert.deepEqual(
      findings.map(({ path, anchored }) => ({ path, anchored })),
      [
        { path: 'src/a.ts', anchored: true },
        { path: '', anchored: false },
        { path: '', anchored: false },
        { path: '', anchored: false },
      ],
    );

    const artifactPath = (
      artifactLocation: { uri: string; uriBaseId?: string },
      repositoryRoot: string,
      originalUriBaseIds?: Record<string, unknown>,
    ) =>
      normalizeCompetitorFindings(
        'sarif',
        {
          runs: [
            {
              ...(originalUriBaseIds ? { originalUriBaseIds } : {}),
              results: [
                {
                  ...result('ROOT'),
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation,
                        region: { startLine: 1 },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        { repositoryRoot },
      )[0].path;
    assert.equal(
      artifactPath({ uri: 'a.ts', uriBaseId: 'ROOT' }, 'C:\\workspace', {
        ROOT: { uri: 'file:///C:/workspace/' },
      }),
      'a.ts',
    );
    assert.equal(
      artifactPath({ uri: 'a.ts', uriBaseId: 'ROOT' }, 'C:\\workspace', {
        ROOT: { uri: 'file:///D:/outside/' },
      }),
      '',
    );
    assert.equal(artifactPath({ uri: 'a.ts' }, 'C:\\workspace'), 'a.ts');
    assert.equal(artifactPath({ uri: 'C:\\workspace\\src\\a.ts' }, 'C:\\workspace'), 'src/a.ts');
    assert.equal(artifactPath({ uri: 'C:/workspace/src/a.ts' }, 'C:\\workspace'), 'src/a.ts');
    assert.equal(artifactPath({ uri: 'file:///workspace/src%2Fa.ts' }, '/workspace'), '');
    assert.equal(artifactPath({ uri: 'https://example.com/src/a.ts' }, '/workspace'), '');
  });

  it('excludes model, endpoint, reasoning, or sampling mismatches from rankings', () => {
    assert.deepEqual(assessCompetitorComparability(configuration, configuration), {
      sameModelComparable: true,
      mismatches: [],
    });
    const mismatch = assessCompetitorComparability(configuration, {
      ...configuration,
      endpoint: 'sha256:other',
      reasoningEffort: 'low',
    });
    assert.equal(mismatch.sameModelComparable, false);
    assert.deepEqual(mismatch.mismatches, ['endpoint', 'reasoningEffort']);
    assert.deepEqual(
      assessCompetitorComparability(configuration, {
        ...configuration,
        sampling: { temperature: 0.5 },
      }).mismatches,
      ['sampling'],
    );
  });
});
