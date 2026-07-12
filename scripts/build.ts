import * as esbuild from 'esbuild';

const shared: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: [
    '@actions/core',
    '@actions/github',
    '@earendil-works/pi-coding-agent',
    '@opencode-ai/sdk',
    '@qoder-ai/qoder-agent-sdk',
    '@octokit/auth-app',
    '@octokit/plugin-paginate-rest',
    '@octokit/plugin-rest-endpoint-methods',
    '@octokit/webhooks',
  ],
};

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

await esbuild.build({
  ...shared,
  entryPoints: ['src/worker/index.ts'],
  outfile: 'dist/worker/index.js',
});

console.log('Build complete.');
