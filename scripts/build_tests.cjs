// Build script for test_reviewEngine.ts using esbuild CLI.
// Usage: node scripts/build_tests.cjs && node scripts/test_reviewEngine.cjs
const { build } = require('esbuild');
const { resolve } = require('path');

const projectRoot = resolve(__dirname, '..');

const testAliasPlugin = {
  name: 'test-alias',
  setup(build) {
    build.onResolve({ filter: /^\.\/supabaseClient$/ }, (args) => {
      const importerDir = args.importer
        ? args.importer.replace(/[/\\][^/\\]+$/, '')
        : projectRoot;
      const resolved = resolve(importerDir, args.path + '.ts');
      if (resolved === resolve(projectRoot, 'src/supabaseClient.ts')) {
        return { path: resolve(projectRoot, 'scripts/test_supabase_stub.ts') };
      }
      return null;
    });
    build.onResolve({ filter: /^\.\.\/supabaseClient$/ }, (args) => {
      const importerDir = args.importer
        ? args.importer.replace(/[/\\][^/\\]+$/, '')
        : projectRoot;
      const resolved = resolve(importerDir, args.path + '.ts');
      if (resolved === resolve(projectRoot, 'src/supabaseClient.ts')) {
        return { path: resolve(projectRoot, 'scripts/test_supabase_stub.ts') };
      }
      return null;
    });
  },
};

build({
  entryPoints: ['scripts/test_reviewEngine.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/test_reviewEngine.cjs',
  plugins: [testAliasPlugin],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': '"http://localhost"',
    'import.meta.env.VITE_SUPABASE_ANON_KEY': '"anon-key"',
    'import.meta.env.VITE_APP_NAME': '"Test"',
  },
  banner: {
    js: `const _g = globalThis;
if (!_g.localStorage) { const _s = {}; _g.localStorage = { getItem: (k) => _s[k] ?? null, setItem: (k, v) => { _s[k] = v; }, removeItem: (k) => { delete _s[k]; } }; }
if (!_g.navigator) _g.navigator = { onLine: true };
if (!_g.window) _g.window = _g;`,
  },
}).then(() => {
  console.log('Test bundle built: scripts/test_reviewEngine.cjs');
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
