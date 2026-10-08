// Verifies the built artifact loads the way node_modules packages load:
// plain JS, no type stripping, bare @deepseek-ai/* imports from the profile
// closure. This is exactly the path that failed with
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING before dist/ existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test(
  'dist/index.js loads as plain JS and exports the plugin contract',
  { skip: !existsSync(distEntry) && 'dist not built — run: node scripts/build.mjs' },
  async () => {
    const mod = await import('../dist/index.js');
    assert.equal(mod.name, 'unoutloud');
    assert.deepEqual(mod.inject, ['tools']);
    assert.equal(typeof mod.apply, 'function');
    assert.ok(mod.Config, 'Config schema exported');
    assert.equal(typeof mod.detect, 'function', 're-exports detect');
    assert.equal(typeof mod.nudgeText, 'function', 're-exports nudgeText');
  },
);
