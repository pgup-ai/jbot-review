import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * opencode plugin that swaps the builtin bash tool's WIRE schema for a
 * Gemini-safe one. opencode serializes bash's `timeout` (int > 0) as JSON
 * Schema `exclusiveMinimum: 0`; OpenAI-compatible proxies fronting a Gemini
 * backend forward tool schemas verbatim into Gemini's Schema proto, which has
 * no such field, so every tool-bearing request 400s and the review attempt
 * dies. The `tool.definition` hook rewrites only what the provider sees —
 * argument validation still runs on opencode's own schema, and `minimum: 1`
 * is the same contract. bash is the only affected tool, and the hook fires
 * for registry tools only (MCP schemas bypass it), so replacing bash's schema
 * outright is both sufficient and the only available lever. Measured on
 * opencode 1.18.21.
 */
const TOOL_SCHEMA_SHIM_PLUGIN = `// jbot-review: bash wire-schema shim; why lives in src/shared/opencode-schema-shim.ts.
export const GeminiSafeToolSchemas = async () => ({
  'tool.definition': async (input, output) => {
    if (input.toolID !== 'bash' || output.jsonSchema !== undefined) return;
    output.jsonSchema = {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'integer', minimum: 1, description: 'Optional timeout in milliseconds' },
        workdir: {
          type: 'string',
          description:
            "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
        },
      },
      required: ['command'],
    };
  },
});
`;

let shimUrl: string | undefined;

/** Materializes the plugin once per process and returns its file URL. */
export function toolSchemaShimPluginUrl(): string {
  if (!shimUrl) {
    const file = join(mkdtempSync(join(tmpdir(), 'jbot-opencode-shim-')), 'bash-schema.js');
    writeFileSync(file, TOOL_SCHEMA_SHIM_PLUGIN);
    shimUrl = pathToFileURL(file).href;
  }
  return shimUrl;
}
