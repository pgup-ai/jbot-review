import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
