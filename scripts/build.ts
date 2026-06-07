import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: [
    '@actions/core',
    '@actions/github',
    '@opencode-ai/sdk',
    '@octokit/auth-app',
    '@octokit/plugin-paginate-rest',
    '@octokit/plugin-rest-endpoint-methods',
    '@octokit/webhooks',
  ],
} as const;

await esbuild.build({
  ...shared,
  entryPoints: ['src/workflow/index.ts'],
  outfile: 'dist/workflow/index.js',
});

await esbuild.build({
  ...shared,
  entryPoints: ['src/app/server.ts'],
  outfile: 'dist/app/server.js',
});

console.log('Build complete.');
