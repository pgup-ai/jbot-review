import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VIEWER_HTML } from '../src/gateway/viewer.ts';

describe('viewer script', () => {
  it('parses as JavaScript', () => {
    // The page is a template literal, so every backslash in the browser code
    // needs doubling: a single \n collapses into a real newline and ends the
    // string literal it was inside. That ships a page whose script cannot
    // parse at all — no run list, no stream, only the static "connecting"
    // label — while typecheck, lint and every substring assertion still pass,
    // because none of them look at the emitted text as code.
    const open = VIEWER_HTML.lastIndexOf('<script>');
    const close = VIEWER_HTML.indexOf('</script>', open);
    assert.ok(open !== -1 && close !== -1, 'viewer ships an inline script');
    const script = VIEWER_HTML.slice(open + '<script>'.length, close);

    assert.doesNotThrow(() => new Function(script), SyntaxError);
  });
});
