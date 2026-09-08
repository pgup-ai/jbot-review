import { repositorySearchArgs, REPOSITORY_SEARCH_PROPERTIES } from './repository-search.ts';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
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
      input: {
        path?: string;
        query?: string | string[];
        paths?: string[];
        offset?: unknown;
        line?: unknown;
      };
    }): Promise<
      { ok: true; content: { type: 'text'; text: string }[] } | { ok: false; error: string }
    >;
  }): void;
}

export default function commandCodeReviewMod(cmd: CommandCodeModApi) {
  const root = realpathSync(process.env.JBOT_COMMANDCODE_WORKSPACE!);
  // The isolated HOME cannot inherit the Action's safe.directory entry.
  const gitArgs = [
    '-c',
    `safe.directory=${root}`,
    '-c',
    'core.fsmonitor=false',
    `--work-tree=${root}`,
  ];
  const gitOptions = { cwd: root, stdio: 'ignore' as const, timeout: 30_000 };
  if (spawnSync('git', [...gitArgs, 'rev-parse', '--show-toplevel'], gitOptions).status !== 0)
    throw new Error('Cannot access the reviewed Git repository.');
  const assertVisible = (rel: string) => {
    const ignored = spawnSync(
      'git',
      [...gitArgs, 'check-ignore', '-q', '--', rel || '.'],
      gitOptions,
    );
    if (ignored.status === 0) throw new Error('Ignored local files are unavailable.');
    if (ignored.status !== 1) throw new Error('Cannot validate repository file visibility.');
  };
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
      let fd: number | undefined;
      try {
        if (typeof input.path !== 'string') throw new Error('Provide a repository file path.');
        const target = realpathSync(resolve(root, input.path));
        const rel = relative(root, target);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
          throw new Error('Path is outside the reviewed repository.');
        if (rel.split(sep).some((part) => part.toLowerCase() === '.git'))
          throw new Error('Git metadata is unavailable.');
        assertVisible(rel);
        fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = fstatSync(fd);
        if (!opened.isFile()) throw new Error('Path is not a regular file.');
        assertVisible(rel);
        const current = statSync(target);
        if (
          realpathSync(target) !== target ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino
        )
          throw new Error('Repository file changed while opening it.');
        const source = createReadStream(target, { fd, encoding: 'utf8' });
        fd = undefined;
        const page = await readRepositoryPage(source, input);
        return { ok: true, content: [{ type: 'text', text: page.text }] };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Repository read failed.',
        };
      } finally {
        if (fd !== undefined) closeSync(fd);
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
            ...(search ? REPOSITORY_SEARCH_PROPERTIES : {}),
            offset,
          },
          required: search ? ['query'] : [],
        },
      },
      readOnly: true,
      async run({ input }) {
        try {
          const args = search
            ? [
                '--no-pager',
                'grep',
                '--no-index',
                '--exclude-standard',
                '--no-color',
                '-n',
                '-I',
                '--no-textconv',
                ...repositorySearchArgs(input),
              ]
            : ['ls-files', '--cached', '--others', '--exclude-standard'];
          const page = await gitRepositoryPage(root, [...gitArgs, ...args], input);
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
