export function benchmarkArgument(name: string, argv = process.argv): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
  }
  const value = argv
    .find((candidate) => candidate.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
  return value && !value.startsWith('--') ? value : undefined;
}
