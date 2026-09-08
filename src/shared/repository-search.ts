import { isRecord } from './text.ts';

export const REPOSITORY_SEARCH_PROPERTIES = {
  query: {
    anyOf: [
      { type: 'string', minLength: 1 },
      { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    ],
  },
  paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
};

export function repositorySearchArgs(input: unknown): string[] {
  const query = isRecord(input) ? input.query : undefined;
  const queries = Array.isArray(query) ? query : [query];
  if (!queries.length || queries.some((q) => typeof q !== 'string' || !q || q.includes('\0')))
    throw new Error('query must be nonempty literal text or an array of nonempty literals');
  const paths = isRecord(input) && input.paths !== undefined ? input.paths : [];
  if (
    !Array.isArray(paths) ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.includes(':') ||
        path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git'),
    )
  )
    throw new Error('paths must be repository-relative literal files or directories');
  return ['-F', ...queries.flatMap((q) => ['-e', q]), '--', ...paths.map((p) => `:(literal)${p}`)];
}
