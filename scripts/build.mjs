// Build dist/ from src/ with Node's built-in type stripping — no bundler,
// no dependencies. Node refuses to type-strip .ts under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the link/bundle install
// route must ship plain JS. The scratch-mount route still uses src/ directly.
//
// Each src file becomes a dist file with local './x.ts' imports rewritten to
// './x.js'. Bare '@deepseek-ai/*' imports stay untouched (they resolve from
// the profile's flat closure). Source is erasable-syntax-only TypeScript, so
// 'strip' mode is exact; it throws loudly if non-erasable syntax ever creeps in.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['index', 'detect', 'prompts'];
mkdirSync(join(root, 'dist'), { recursive: true });

for (const file of files) {
  const src = readFileSync(join(root, 'src', `${file}.ts`), 'utf8');
  const js = stripTypeScriptTypes(src, { mode: 'strip' }).replace(
    /(from\s+['"])(\.\/[\w-]+)\.ts(['"])/g,
    '$1$2.js$3',
  );
  writeFileSync(join(root, 'dist', `${file}.js`), js);
  console.log(`built dist/${file}.js`);
}
