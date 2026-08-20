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
                rules: [{ id: 'contract', messageStrings: { primary: { text: 'Rule message' } } }],
                globalMessageStrings: { global: { text: 'Global message' } },
              },
            },
            results: [
              { ruleIndex: 0, level: 'warning', message: { id: 'primary' } },
              { level: 'note', message: { id: 'global' } },
            ],
          },
        ],
      }).map(({ title, severity }) => ({ title, severity })),
      [
        { title: 'Rule message', severity: 'P2' },
        { title: 'Global message', severity: 'P3' },
      ],
    );
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
