import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { startOpencode } from '../src/shared/opencode.ts';
import { toolSchemaShimPluginUrl } from '../src/shared/opencode-hardening.ts';

interface ToolDefinitionOutput {
  description?: string;
  parameters?: unknown;
  jsonSchema?: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}
type ToolDefinitionHook = (
  input: { toolID: string },
  output: ToolDefinitionOutput,
) => Promise<void>;

describe('opencode bash schema shim', () => {
  it('replaces only the builtin bash wire schema with a Gemini-safe one', async () => {
    const url = toolSchemaShimPluginUrl();
    assert.equal(toolSchemaShimPluginUrl(), url);

    const module = (await import(url)) as Record<
      string,
      () => Promise<Record<string, ToolDefinitionHook>>
    >;
    const hook = (await Object.values(module)[0]())['tool.definition'];

    const validation = { original: true };
    const bash: ToolDefinitionOutput = { description: 'd', parameters: validation };
    await hook({ toolID: 'bash' }, bash);
    assert.ok(bash.jsonSchema, 'bash gets a replacement wire schema');
    assert.ok(!JSON.stringify(bash.jsonSchema).includes('exclusiveM'));
    assert.equal(bash.jsonSchema.properties?.timeout?.minimum, 1);
    assert.deepEqual(bash.jsonSchema.required, ['command']);
    assert.equal(bash.parameters, validation, 'validation schema stays untouched');

    const grep: ToolDefinitionOutput = { parameters: validation };
    await hook({ toolID: 'grep' }, grep);
    assert.equal(grep.jsonSchema, undefined, 'other builtins pass through');

    const preset: ToolDefinitionOutput = { jsonSchema: { required: ['keep'] } };
    await hook({ toolID: 'bash' }, preset);
    assert.deepEqual(preset.jsonSchema, { required: ['keep'] }, 'a provided schema is respected');
  });
});

// The isolated hook test above would still pass if a future opencode
// pre-populated `output.jsonSchema` or failed to load the file:// plugin — the
// shim would silently no-op and the Gemini 400 return. This drives the shipped
// path (opencode resolves the plugin and emits the request) and asserts the
// bash schema on the wire is Gemini-safe. Needs the opencode binary.
const hasOpencode = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;

describe('bash schema on the wire', { skip: !hasOpencode }, () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('opencode loads the shim and emits a Gemini-safe bash schema', async () => {
    const requests: Array<{ tools?: Array<{ function: { name: string; parameters: unknown } }> }> =
      [];
    const mock = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (body) requests.push(JSON.parse(body));
        // opencode retry-loops unless the provider speaks SSE.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: 'ok' }, null));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
    const port = (mock.address() as { port: number }).port;

    const workspace = mkdtempSync(join(tmpdir(), 'jbot-wire-'));
    roots.push(workspace);
    const { client, stop } = await startOpencode(
      workspace,
      'openai-compatible',
      'stub/model',
      'mock',
      () => {},
      { baseURL: `http://127.0.0.1:${port}/v1`, port: 0, scrubEnv: false },
    );
    try {
      const created = await client.session.create({
        body: { title: 'wire' },
        query: { directory: workspace },
      });
      const sid = (created.data as { id: string }).id;
      // Leave bash on (READONLY_TOOLS shape) so it reaches the provider.
      await client.session.promptAsync({
        path: { id: sid },
        query: { directory: workspace },
        body: {
          model: { providerID: 'openai-compatible', modelID: 'stub/model' },
          agent: 'plan',
          tools: { write: false, edit: false, patch: false },
          parts: [{ type: 'text', text: 'hi' }],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      stop();
      mock.close();
    }

    const bash = requests.flatMap((r) => r.tools ?? []).find((t) => t.function.name === 'bash');
    assert.ok(bash, 'bash tool reached the provider');
    assert.ok(!JSON.stringify(bash).includes('exclusiveM'), 'bash wire schema is Gemini-safe');
    assert.equal(
      (bash.function.parameters as { properties: { timeout: { minimum: number } } }).properties
        .timeout.minimum,
      1,
    );
  });
});
