import { createReadStream, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  const names = ['jbot_read_file', 'read_directory', 'jbot_search', 'jbot_list_files'];
  const offset = {
    type: 'integer',
    minimum: 0,
    description:
      'Byte offset copied from an explicit next-page notice, not a line or match count. Omit for the first page. End of output means there is no next page.',
  };
  const literal = (path: unknown): string => {
    if (typeof path !== 'string') throw new Error('Provide a repository file path.');
    const target = realpathSync(resolve(root, path));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
      throw new Error('Path is outside the reviewed repository.');
    return target;
  };
  cmd.setActiveTools(names);
  cmd.hooks({
    beforeToolCall({ toolName, input }) {
      try {
        if (!names.includes(toolName))
          throw new Error('Only repository read/search tools are enabled.');
        if (toolName === 'read_directory') return { input: { path: literal(input.path ?? root) } };
        return { input };
      } catch (error) {
        return {
          block: true,
          additionalContext:
            error instanceof Error ? error.message : 'Invalid repository tool input.',
        };
      }
    },
  });
  cmd.addTool({
    schema: {
      name: 'jbot_read_file',
      description:
        'Read a UTF-8 repository file, following only symlinks that stay inside the repository. Paths are literal, including brackets. Continue with the returned offset or start at a 1-based line.',
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
        const target = literal(input.path);
        if (!statSync(target).isFile()) throw new Error('Path is not a regular file.');
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
          ? 'Search tracked repository files for literal text. Results include path and line number. Continue with the returned offset.'
          : 'List tracked and non-ignored untracked repository file paths. Continue with the returned offset.',
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
                '--no-color',
                '-n',
                '-I',
                '-F',
                '--no-textconv',
                '--no-recurse-submodules',
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
