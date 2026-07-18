import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { format } from 'prettier';

import { parseCommandCodeModelList } from '../src/shared/commandcode.ts';
import { PROVIDERS } from '../src/shared/config.ts';
import { parseCursorModelList } from '../src/shared/cursor.ts';
import { parseKiloModelList } from '../src/shared/kilo.ts';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CLINE_RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';
const GROK_CATALOG_EXPLANATION_URL =
  'https://deepwiki.com/search/where-can-i-find-the-full-mode_fd2151c4-f7ba-489b-a56b-f5e01566e81c?mode=fast';
const OUTPUT_PATH = fileURLToPath(new URL('../MODEL_CATALOG.md', import.meta.url));
const DOCKERFILE_PATH = fileURLToPath(new URL('../Dockerfile', import.meta.url));
const COMMAND_TIMEOUT_MS = 2 * 60_000;

interface ModelsDevProvider {
  models: Record<string, unknown>;
}

interface RuntimeCatalog {
  discovery: string;
  source: string;
  note: string;
  models: string[];
  enumerable?: boolean;
}

interface ClineRecommendedModels {
  clinePass?: Array<{ id?: unknown }>;
}

function isModelsDevProvider(value: unknown): value is ModelsDevProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    'models' in value &&
    typeof value.models === 'object' &&
    value.models !== null
  );
}

function renderTableRow(values: string[]): string {
  return `| ${values.join(' | ')} |`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function withDefault(providerID: string, models: string[]): string[] {
  const defaultModel = PROVIDERS[providerID]?.defaultModel;
  return uniqueSorted(defaultModel ? [defaultModel, ...models] : models);
}

function run(command: string, args: string[], label: string): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `Failed to refresh ${label}. Install/authenticate that CLI, then rerun npm run models:update.`,
    );
  }
}

function dockerPackageVersion(packageName: string): string {
  const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = dockerfile.match(new RegExp(`${escaped}@([^\\s\\\\]+)`));
  if (!match?.[1]) throw new Error(`Missing ${packageName} version in Dockerfile.`);
  return match[1];
}

function npmCliOutput(packageName: string, bin: string, args: string[]): string {
  const version = dockerPackageVersion(packageName);
  return run(
    'npm',
    ['exec', '--yes', `--package=${packageName}@${version}`, '--', bin, ...args],
    `${packageName}@${version} model catalog`,
  );
}

function npmSource(packageName: string): string {
  const version = dockerPackageVersion(packageName);
  return `Docker-pinned npm package [\`${packageName}@${version}\`](https://www.npmjs.com/package/${packageName})`;
}

function parseQoderModels(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== 'MODEL')
    .map((model) => (model === 'Auto' ? 'auto' : model));
}

function parseCodexModels(output: string): string[] {
  const parsed = JSON.parse(output) as { models?: Array<{ slug?: unknown }> };
  if (!Array.isArray(parsed.models)) throw new Error('Codex model output has no models array.');
  return parsed.models.flatMap((model) => (typeof model.slug === 'string' ? [model.slug] : []));
}

function parseGrokModels(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*\*\s+(\S+)/);
    return match?.[1] ? [match[1]] : [];
  });
}

async function loadClineModels(): Promise<{ models: string[]; llmsVersion: string }> {
  const clineVersion = dockerPackageVersion('cline');
  const llmsVersion = JSON.parse(
    run(
      'npm',
      ['view', `cline@${clineVersion}`, 'dependencies.@cline/llms', '--json'],
      `cline@${clineVersion} npm metadata`,
    ),
  ) as unknown;
  if (typeof llmsVersion !== 'string' || !llmsVersion) {
    throw new Error(`cline@${clineVersion} does not declare @cline/llms.`);
  }

  const installDir = mkdtempSync(join(tmpdir(), 'jbot-cline-model-catalog-'));
  try {
    run(
      'npm',
      [
        'install',
        '--silent',
        '--ignore-scripts',
        '--prefix',
        installDir,
        `@cline/llms@${llmsVersion}`,
      ],
      `@cline/llms@${llmsVersion} catalog package`,
    );
    const modulePath = pathToFileURL(
      join(installDir, 'node_modules', '@cline', 'llms', 'dist', 'index.js'),
    ).href;
    const llms = (await import(modulePath)) as {
      getModelsForProvider(providerID: string): Promise<Record<string, unknown>>;
    };
    return {
      models: Object.keys(await llms.getModelsForProvider('cline')),
      llmsVersion,
    };
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

async function loadClinePassModels(): Promise<string[]> {
  const response = await fetch(CLINE_RECOMMENDED_MODELS_URL);
  if (!response.ok) {
    throw new Error(`Cline model request failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as ClineRecommendedModels;
  if (!Array.isArray(payload.clinePass)) {
    throw new Error('Cline model response has no clinePass catalog.');
  }
  return payload.clinePass.flatMap(({ id }) => (typeof id === 'string' ? [id] : []));
}

async function loadRuntimeCatalogs(): Promise<Record<string, RuntimeCatalog>> {
  const commandCodeModels = parseCommandCodeModelList(
    npmCliOutput('command-code', 'command-code', ['--list-models']),
  );
  const cursorModels = parseCursorModelList(
    run('cursor-agent', ['models'], 'Cursor model catalog'),
  );
  const qoderModels = parseQoderModels(
    npmCliOutput('@qoder-ai/qodercli', 'qodercli', ['--list-models']),
  );
  const codexModels = parseCodexModels(npmCliOutput('@openai/codex', 'codex', ['debug', 'models']));
  const { models: clineModels, llmsVersion } = await loadClineModels();
  const clinePassModels = await loadClinePassModels();
  const grokModels = parseGrokModels(npmCliOutput('@xai-official/grok', 'grok', ['models']));
  const kiloModels = parseKiloModelList(
    npmCliOutput('@kilocode/cli', 'kilo', ['models', '--pure']),
  );
  for (const [providerID, models] of Object.entries({
    commandcode: commandCodeModels,
    cursor: cursorModels,
    qoder: qoderModels,
    codex: codexModels,
    cline: clineModels,
    'cline-pass': clinePassModels,
    grok: grokModels,
    kilo: kiloModels,
  })) {
    if (models.length === 0) throw new Error(`${providerID} returned no model IDs.`);
  }

  return {
    devin: {
      discovery: '`devin --help` and the interactive model picker',
      source: 'Vendor-installed Devin CLI (the Docker image does not install an npm package)',
      note: 'Devin exposes model selection but no machine-readable or non-interactive list. Only the supported `default` sentinel is cataloged; explicit IDs remain account/version dependent.',
      models: withDefault('devin', []),
      enumerable: false,
    },
    commandcode: {
      discovery: '`command-code --list-models`',
      source: `${npmSource('command-code')} authenticated catalog`,
      note: 'The command returns the models available to the current CommandCode account.',
      models: withDefault(
        'commandcode',
        commandCodeModels.map((model) => `commandcode/${model}`),
      ),
    },
    cursor: {
      discovery: '`cursor-agent models`',
      source: 'Vendor-installed Cursor CLI (the Docker image does not install an npm package)',
      note: 'The command returns the current account catalog, including parameterized reasoning and fast variants.',
      models: withDefault(
        'cursor',
        cursorModels.map((model) => `cursor/${model}`),
      ),
    },
    qoder: {
      discovery: '`qodercli --list-models`',
      source: `${npmSource('@qoder-ai/qodercli')} model catalog`,
      note: 'Names are passed unchanged to the Qoder Agent SDK; `Auto` is normalized to the SDK value `auto`.',
      models: withDefault(
        'qoder',
        qoderModels.map((model) => `qoder/${model}`),
      ),
    },
    codex: {
      discovery: '`codex debug models`',
      source: `${npmSource('@openai/codex')} authenticated catalog`,
      note: 'The command returns model slugs available to the current Codex account.',
      models: withDefault(
        'codex',
        codexModels.map((model) => `codex/${model}`),
      ),
    },
    cline: {
      discovery: `the \`@cline/llms\` catalog bundled by \`cline@${dockerPackageVersion('cline')}\``,
      source: `${npmSource('cline')} → [\`@cline/llms@${llmsVersion}\`](https://www.npmjs.com/package/@cline/llms)`,
      note: 'Pay-as-you-go IDs include the upstream model type, for example `cline/deepseek/deepseek-v4-flash`.',
      models: withDefault(
        'cline',
        clineModels.map((model) => `cline/${model}`),
      ),
    },
    'cline-pass': {
      discovery: `[Cline's live recommended-models endpoint](${CLINE_RECOMMENDED_MODELS_URL})`,
      source: `${npmSource('cline')} live ClinePass catalog`,
      note: 'The endpoint already returns `cline-pass/…` IDs, which are the exact J-Bot values.',
      models: withDefault('cline-pass', clinePassModels),
    },
    grok: {
      discovery: '`grok models`',
      source: `${npmSource('@xai-official/grok')} authenticated remote catalog`,
      note: `Grok resolves user configuration, then its remote \`/v1/models\` response, then package defaults. The current command result is therefore the exact account-visible list, not a guessed static list; see the [Grok catalog trace](${GROK_CATALOG_EXPLANATION_URL}).`,
      models: withDefault(
        'grok',
        grokModels.map((model) => `grok/${model}`),
      ),
    },
    kilo: {
      discovery: '`kilo models --pure`',
      source: `${npmSource('@kilocode/cli')} live catalog`,
      note: 'Kilo already prints fully qualified J-Bot values such as `kilo/openai/gpt-5.4`; do not add another `kilo/` prefix.',
      models: withDefault('kilo', kiloModels),
    },
  };
}

async function main(): Promise<void> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(`Models.dev request failed: ${response.status} ${response.statusText}`);
  }
  const modelsDev = (await response.json()) as Record<string, unknown>;
  const runtimeCatalogs = await loadRuntimeCatalogs();
  const generated = new Date().toISOString().slice(0, 10);
  const publicProviders: Array<{
    providerID: string;
    defaultModel?: string;
    catalogDefault?: string;
    models: string[];
  }> = [];
  const runtimeProviders: Array<{ providerID: string; catalog: RuntimeCatalog }> = [];
  const customProviders: Array<{ providerID: string; name: string }> = [];

  for (const [providerID, config] of Object.entries(PROVIDERS)) {
    if (config.custom) {
      customProviders.push({ providerID, name: config.custom.name });
      continue;
    }
    const runtime = runtimeCatalogs[providerID];
    if (runtime) {
      runtimeProviders.push({ providerID, catalog: runtime });
      continue;
    }
    const provider = modelsDev[providerID];
    if (!isModelsDevProvider(provider)) {
      throw new Error(`Provider "${providerID}" is missing from Models.dev and runtime catalogs.`);
    }
    const models = Object.keys(provider.models)
      .map((modelID) => `${providerID}/${modelID}`)
      .sort((a, b) => a.localeCompare(b));
    const defaultModelID = config.defaultModel?.slice(`${providerID}/`.length);
    const catalogDefault = config.defaultModel
      ? models.find(
          (model) =>
            model === config.defaultModel ||
            (defaultModelID && model.endsWith(`/${defaultModelID}`)),
        )
      : undefined;
    if (config.defaultModel && !catalogDefault) {
      throw new Error(
        `Default model "${config.defaultModel}" is missing from Models.dev provider "${providerID}".`,
      );
    }
    publicProviders.push({
      providerID,
      defaultModel: config.defaultModel,
      catalogDefault,
      models,
    });
  }

  const lines = [
    '<!-- Generated by npm run models:update; do not edit directly. -->',
    '',
    '# J-Bot model ID catalog',
    '',
    `Generated on **${generated}** from the live [Models.dev catalog](${MODELS_DEV_URL}), Docker-pinned CLI npm packages, and authenticated CLI catalogs by \`npm run models:update\`.`,
    '',
    'J-Bot model values use `provider/model-id`. You may pass either the full value shown here or the model-id portion when `provider` is configured separately. Provider access, region, account tier, and model retirement can change independently of this snapshot.',
    '',
    "The Models.dev sections contain every model ID advertised for J-Bot's public OpenCode providers, including non-chat modalities. Choose a text-capable model appropriate for code review. CLI sections are exact snapshots from the source named in each section: public/package catalogs where available and the authenticated account otherwise.",
    '',
    'Refreshing CLI sections requires the Docker-pinned npm packages plus valid local authentication for account-scoped CLIs. The script reads credentials through each CLI and never writes them to the catalog.',
    '',
    '## Provider index',
    '',
    renderTableRow(['Provider', 'Catalog', 'Models', 'J-Bot default']),
    renderTableRow(['---', '---', '---:', '---']),
    ...publicProviders.map(({ providerID, defaultModel, models }) =>
      renderTableRow([
        `\`${providerID}\``,
        'Models.dev',
        String(models.length),
        defaultModel ? `\`${defaultModel}\`` : 'required',
      ]),
    ),
    ...runtimeProviders.map(({ providerID, catalog }) =>
      renderTableRow([
        `\`${providerID}\``,
        catalog.enumerable === false ? 'CLI (not enumerable)' : 'CLI snapshot',
        catalog.enumerable === false ? '—' : String(catalog.models.length),
        PROVIDERS[providerID]?.defaultModel
          ? `\`${PROVIDERS[providerID].defaultModel}\``
          : 'required',
      ]),
    ),
    ...customProviders.map(({ providerID }) =>
      renderTableRow([`\`${providerID}\``, 'Custom endpoint', 'dynamic', 'required']),
    ),
    '',
    '## Models.dev providers',
    '',
  ];

  for (const { providerID, defaultModel, catalogDefault, models } of publicProviders) {
    lines.push(
      `### \`${providerID}\``,
      '',
      `${models.length} model IDs. Default: ${defaultModel ? `\`${defaultModel}\`` : 'none'}.`,
      '',
      ...models.map((model) => {
        if (model !== catalogDefault) return `- \`${model}\``;
        const suffix = model === defaultModel ? 'default' : `catalog form of ${defaultModel}`;
        return `- \`${model}\` **(${suffix})**`;
      }),
      '',
    );
  }

  lines.push('## CLI providers', '');
  for (const { providerID, catalog } of runtimeProviders) {
    const defaultModel = PROVIDERS[providerID]?.defaultModel;
    lines.push(
      `### \`${providerID}\``,
      '',
      `- Source: ${catalog.source}.`,
      `- Refresh/list: ${catalog.discovery}.`,
      `- Note: ${catalog.note}`,
      '',
      catalog.enumerable === false
        ? 'The CLI does not expose a complete list.'
        : `${catalog.models.length} J-Bot model values:`,
      '',
      ...catalog.models.map((model) =>
        model === defaultModel ? `- \`${model}\` **(default)**` : `- \`${model}\``,
      ),
      '',
    );
  }

  lines.push('## Custom providers', '');
  for (const { providerID, name } of customProviders) {
    lines.push(
      `### \`${providerID}\``,
      '',
      `${name} has no shared model catalog. Use \`${providerID}/<endpoint-model-id>\`, where \`<endpoint-model-id>\` is the exact ID exposed by that endpoint. J-Bot requires it explicitly and does not invent or probe a default.`,
      '',
    );
  }

  writeFileSync(OUTPUT_PATH, await format(`${lines.join('\n')}\n`, { parser: 'markdown' }));
  console.log(
    `Wrote ${OUTPUT_PATH} (${publicProviders.reduce((sum, provider) => sum + provider.models.length, 0)} Models.dev IDs; ${runtimeProviders.reduce((sum, provider) => sum + provider.catalog.models.length, 0)} CLI values).`,
  );
}

await main();
