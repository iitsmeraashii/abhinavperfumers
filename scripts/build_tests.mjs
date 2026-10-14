// Build script for dashboard tests. Uses esbuild JS API with a custom
// plugin to alias external boundary modules with test stubs.
//
// Run: node scripts/build_tests.mjs

import { build } from 'esbuild';
import { resolve } from 'path';

const projectRoot = new URL('..', import.meta.url).pathname;

// Map of real module paths → stub paths (both as absolute paths).
// Default stubs (used for dashboard metrics tests)
const DASHBOARD_STUBS = {
  [resolve(projectRoot, 'src/supabaseClient.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_supabase.ts'),
  [resolve(projectRoot, 'src/authModeState.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_authMode.ts'),
  [resolve(projectRoot, 'src/connectivity/connectivityStore.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_connectivity.ts'),
};

// Stubs for follow-up tile tests — uses the query-builder stub for supabase
const FOLLOWUP_STUBS = {
  [resolve(projectRoot, 'src/supabaseClient.ts')]: resolve(projectRoot, 'scripts/test_followup_count_stub_supabase.ts'),
  [resolve(projectRoot, 'src/authModeState.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_authMode.ts'),
  [resolve(projectRoot, 'src/connectivity/connectivityStore.ts')]: resolve(projectRoot, 'scripts/test_dashboard_stub_connectivity.ts'),
};

function makeAliasPlugin(stubs) {
  return {
    name: 'test-alias',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith('.')) return null;

        const importerDir = args.importer
          ? args.importer.replace(/[/\\][^/\\]+$/, '')
          : projectRoot;
        const resolved = resolve(importerDir, args.path + '.ts');
        const resolvedNoExt = resolve(importerDir, args.path);

        const stub = stubs[resolved] || stubs[resolvedNoExt];
        if (stub) {
          return { path: stub };
        }

        return null;
      });
    },
  };
}

await build({
  entryPoints: ['scripts/test_dashboardMetrics.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/test_dashboardMetrics.cjs',
  plugins: [makeAliasPlugin(DASHBOARD_STUBS)],
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

await build({
  entryPoints: ['scripts/test_todaysFollowUpsTile.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/test_todaysFollowUpsTile.cjs',
  plugins: [makeAliasPlugin(FOLLOWUP_STUBS)],
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

console.log('Test bundle built: scripts/test_todaysFollowUpsTile.cjs');
