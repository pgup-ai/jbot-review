import * as esbuild from 'esbuild';

const shared: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: [
    '@actions/core',
    '@actions/github',
    '@earendil-works/pi-ai',
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

await esbuild.build({
  ...shared,
  entryPoints: ['src/gateway/server.ts'],
  outfile: 'dist/gateway/server.js',
});

// The bundles are ESM; copying only `dist/` drops the repo-root package.json
// that tells Node so. Emit a minimal one so `node dist/gateway/server.js`
// (the documented deploy) runs from a bare `dist/`.
const { writeFileSync } = await import('node:fs');
writeFileSync('dist/package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

console.log('Build complete.');
