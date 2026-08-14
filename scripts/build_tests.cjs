// esbuild plugin to stub supabaseClient for Node tests.
const supabaseStubPlugin = {
  name: 'supabase-stub',
  setup(build) {
    build.onResolve({ filter: /supabaseClient$/ }, (args) => {
      return { path: require('path').resolve('scripts/test_supabase_stub.ts') };
    });
  },
};

require('esbuild').build({
  entryPoints: ['scripts/test_reviewEngine.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'scripts/test_reviewEngine.cjs',
  plugins: [supabaseStubPlugin],
  define: { 'import.meta.env': 'undefined' },
}).then(() => {
  console.log('Build complete.');
}).catch(() => process.exit(1));
