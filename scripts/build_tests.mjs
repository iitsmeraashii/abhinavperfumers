// Build script for dashboard tests. Uses esbuild JS API with a custom
// plugin to alias external boundary modules with test stubs.
//
// Run: node scripts/build_tests.mjs

import { build } from 'esbuild';
import { resolve } from 'path';

const projectRoot = new URL('..', import.meta.url).pathname;

// Map of real module paths → stub paths (both as absolute paths).
const STUBS = {
  [resolve(projectRoot, 'src/supabaseClient.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_supabase.ts'),
  [resolve(projectRoot, 'src/authModeState.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_authMode.ts'),
  [resolve(projectRoot, 'src/connectivity/connectivityStore.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_connectivity.ts'),
};

const testAliasPlugin = {
  name: 'test-alias',
  setup(build) {
    // Intercept ALL onResolve calls and check if the resolved path
    // matches one of our stubs.
    build.onResolve({ filter: /.*/ }, (args) => {
      // Only intercept relative imports (./ or ../).
      if (!args.path.startsWith('.')) return null;

      // Resolve the import path relative to the importer directory.
      const importerDir = args.importer
        ? args.importer.replace(/[/\\][^/\\]+$/, '')
        : projectRoot;
      const resolved = resolve(importerDir, args.path + '.ts');
      const resolvedNoExt = resolve(importerDir, args.path);

      // Check both with and without .ts extension.
      const stub = STUBS[resolved] || STUBS[resolvedNoExt];
      if (stub) {
        return { path: stub };
      }

      return null;
    });
  },
};

await build({
  entryPoints: ['scripts/test_dashboardMetrics.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/test_dashboardMetrics.cjs',
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
});

console.log('Test bundle built: scripts/test_dashboardMetrics.cjs');
