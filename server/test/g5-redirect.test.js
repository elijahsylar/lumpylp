// react-router 6.x (all versions) has an open-redirect advisory via
// backslashes (GHSA-wrjc-x8rr-h8h6); the fix is v7, deferred to the redesign.
// Until then the login page only follows redirects that pass safeRedirect().
// Node 24 strips the TypeScript types, so the client module is imported as is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRedirect } from '../../client/src/lib/redirect.ts';

test('only same-origin paths are followed', () => {
  for (const ok of ['/lumps', '/lumps/12?x=1', '/#work']) assert.equal(safeRedirect(ok), ok);
  for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example',
    '/\\/evil.example', 'javascript:alert(1)', '/%5Cevil.example', '/\tevil', '/x\nLocation: y']) {
    assert.equal(safeRedirect(bad), '/', String(bad));
  }
});
