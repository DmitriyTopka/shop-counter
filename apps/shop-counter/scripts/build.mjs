// Bundles the local server and the Lambda entry into dist/ (no node_modules needed at runtime),
// and copies the MCP App view next to the bundle when packages/view has been built.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { http: 'src/http.ts', lambda: 'src/lambda.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['shelf-source'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  sourcemap: 'linked',
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

const view = resolve(root, '..', '..', 'packages', 'view', 'dist', 'view.html');
if (existsSync(view)) {
  copyFileSync(view, join(root, 'dist', 'view.html'));
  console.log(`[build] view.html copied (${(statSync(view).size / 1024).toFixed(1)} KB)`);
} else {
  console.log('[build] packages/view/dist/view.html not built yet: the server will serve a placeholder view');
}
for (const f of ['http.mjs', 'lambda.mjs']) console.log(`[build] dist/${f} ${(statSync(join(root, 'dist', f)).size / 1024).toFixed(0)} KB`);
