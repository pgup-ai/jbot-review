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

await esbuild.build({
  ...shared,
  entryPoints: ['src/companion/index.ts'],
  outfile: 'dist/companion/index.js',
});

// The bundles are ESM; copying only `dist/` drops the repo-root package.json
// that tells Node so. Emit a minimal one so `node dist/gateway/server.js`
// (the documented deploy) runs from a bare `dist/`.
//
// name/version are load-bearing, not decoration: bundled @symma/protocol reads
// them back out of THIS file to fill ACP `clientInfo`, and agents reject an
// empty one (-32602). Dropping them fails only on ACP backends, at handshake.
const { readFileSync, writeFileSync } = await import('node:fs');
const { name, version } = JSON.parse(readFileSync('package.json', 'utf8')) as Record<
  string,
  string
>;
writeFileSync(
  'dist/package.json',
  `${JSON.stringify({ name, version, type: 'module' }, null, 2)}\n`,
);

console.log('Build complete.');
