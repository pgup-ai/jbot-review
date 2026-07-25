import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anchorByEvidenceSnippet } from '../src/shared/patch.ts';

// newLine starts at 1: context, added, added, context.
const PATCH = [
  '@@ -1,2 +1,4 @@',
  ' const a = 1;',
  '+const b = compute(a);',
  '+return b;',
  ' const c = 3;',
].join('\n');

describe('anchorByEvidenceSnippet', () => {
  it('anchors a multi-line snippet to the first added line it covers', () => {
    // Spanning a context line is the point: it makes a short snippet unique,
    // but the anchor must still land somewhere GitHub accepts.
    assert.equal(anchorByEvidenceSnippet(PATCH, 'const a = 1;\nconst b = compute(a);'), 2);
    assert.equal(anchorByEvidenceSnippet(PATCH, 'const b = compute(a);\nreturn b;'), 2);

    // Diff markers and indentation are normalized away on both sides.
    assert.equal(anchorByEvidenceSnippet(PATCH, '+  const b = compute(a);\n+return b;'), 2);

    // Leading/trailing blank lines are trimmed; a single line still works.
    assert.equal(anchorByEvidenceSnippet(PATCH, '\nreturn b;\n'), 3);

    assert.equal(anchorByEvidenceSnippet(PATCH, 'not in this patch'), undefined);
    assert.equal(anchorByEvidenceSnippet(undefined, 'return b;'), undefined);
    assert.equal(anchorByEvidenceSnippet(PATCH, '   \n  '), undefined);
  });

  it('refuses to anchor a snippet that matches more than once', () => {
    const repeated = [
      '@@ -0,0 +1,3 @@',
      '+  return null;',
      '+const x = 1;',
      '+  return null;',
    ].join('\n');
    assert.equal(anchorByEvidenceSnippet(repeated, 'return null;'), undefined);
    // The longer snippet is unique again, which is why multi-line evidence helps.
    assert.equal(anchorByEvidenceSnippet(repeated, 'return null;\nconst x = 1;'), 1);
  });

  it('keeps a genuine leading sign in source instead of reading it as a diff marker', () => {
    // newSideLines already stripped the real marker, so stripping again would
    // collapse '-1;' and '1;' to the same text and mis-anchor between them.
    const signs = ['@@ -0,0 +1,2 @@', '+  -1;', '+  1;'].join('\n');

    assert.equal(anchorByEvidenceSnippet(signs, '-1;'), 1);
    assert.equal(anchorByEvidenceSnippet(signs, '1;'), 2);
    // The model may also quote the line with the diff marker still attached.
    assert.equal(anchorByEvidenceSnippet(signs, '+  -1;'), 1);
  });

  it('refuses to anchor a match containing no added line', () => {
    // Context-only quotes have no postable anchor; they fall through to the
    // existing file-level chain rather than anchoring to an unchanged line.
    assert.equal(anchorByEvidenceSnippet(PATCH, 'const a = 1;'), undefined);
    assert.equal(anchorByEvidenceSnippet(PATCH, 'const c = 3;'), undefined);
  });
});
