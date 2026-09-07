import { spawnSync } from 'node:child_process';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { COMMANDCODE_TOOL_DESCRIPTIONS } from './prompt.ts';
import { gitRepositoryPage, readRepositoryPage } from './repository-output.ts';

interface CommandCodeModApi {
  setActiveTools(names: string[]): void;
  hooks(hooks: {
    beforeToolCall(call: {
      toolName: string;
      input: Record<string, unknown>;
    }): { input: Record<string, unknown> } | { block: true; additionalContext: string };
  }): void;
  addTool(tool: {
    schema: { name: string; description: string; input_schema: Record<string, unknown> };
    readOnly: true;
    run(call: {
      input: { path?: string; query?: string; offset?: unknown; line?: unknown };
    }): Promise<
      { ok: true; content: { type: 'text'; text: string }[] } | { ok: false; error: string }
    >;
  }): void;
}

export default function commandCodeReviewMod(cmd: CommandCodeModApi) {
  const root = realpathSync(process.env.JBOT_COMMANDCODE_WORKSPACE!);
  const names = ['jbot_read_file', 'jbot_search', 'jbot_list_files'];
  const offset = {
    type: 'integer',
    minimum: 0,
    description: COMMANDCODE_TOOL_DESCRIPTIONS.offset,
  };
  cmd.setActiveTools(names);
  cmd.hooks({
    beforeToolCall({ toolName, input }) {
      return names.includes(toolName)
        ? { input }
        : { block: true, additionalContext: 'Only repository read/search tools are enabled.' };
    },
  });
  cmd.addTool({
    schema: {
      name: 'jbot_read_file',
      description: COMMANDCODE_TOOL_DESCRIPTIONS.read,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset,
          line: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
      },
    },
    readOnly: true,
    async run({ input }) {
      try {
        if (typeof input.path !== 'string') throw new Error('Provide a repository file path.');
        const target = realpathSync(resolve(root, input.path));
        const rel = relative(root, target);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
          throw new Error('Path is outside the reviewed repository.');
        if (rel.split(sep).some((part) => part.toLowerCase() === '.git'))
          throw new Error('Git metadata is unavailable.');
        if (!statSync(target).isFile()) throw new Error('Path is not a regular file.');
        const ignored = spawnSync(
          'git',
          ['-c', 'core.fsmonitor=false', `--work-tree=${root}`, 'check-ignore', '-q', '--', rel],
          { cwd: root, stdio: 'ignore', timeout: 30_000 },
        );
        if (ignored.status === 0) throw new Error('Ignored local files are unavailable.');
        if (ignored.status !== 1) throw new Error('Cannot validate repository file visibility.');
        const page = await readRepositoryPage(
          createReadStream(target, { encoding: 'utf8' }),
          input,
        );
        return { ok: true, content: [{ type: 'text', text: page.text }] };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Repository read failed.',
        };
      }
    },
  });
  for (const search of [false, true]) {
    cmd.addTool({
      schema: {
        name: search ? 'jbot_search' : 'jbot_list_files',
        description: search
          ? COMMANDCODE_TOOL_DESCRIPTIONS.search
          : COMMANDCODE_TOOL_DESCRIPTIONS.list,
        input_schema: {
          type: 'object',
          properties: {
            ...(search ? { query: { type: 'string', minLength: 1 } } : {}),
            offset,
          },
          required: search ? ['query'] : [],
        },
      },
      readOnly: true,
      async run({ input }) {
        try {
          if (search && (typeof input.query !== 'string' || !input.query))
            throw new Error('query must be nonempty');
          const args = search
            ? [
                '--no-pager',
                'grep',
                '--no-index',
                '--exclude-standard',
                '--no-color',
                '-n',
                '-I',
                '-F',
                '--no-textconv',
                '-e',
                input.query!,
                '--',
              ]
            : ['ls-files', '--cached', '--others', '--exclude-standard'];
          const page = await gitRepositoryPage(
            root,
            ['-c', 'core.fsmonitor=false', `--work-tree=${root}`, ...args],
            input,
          );
          return {
            ok: true,
            content: [{ type: 'text', text: page.totalBytes ? page.text : '(no matches)' }],
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Repository tool failed.',
          };
        }
      },
    });
  }
}
