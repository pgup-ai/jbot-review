import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type ProxyLogger = {
  info: (message: string) => void;
  warning: (message: string) => void;
};

type EgressCheck = (env: NodeJS.ProcessEnv) => Promise<string>;

async function checkProxyEgress(env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/curl',
    [
      '--disable',
      '--fail',
      '--silent',
      '--connect-timeout',
      '5',
      '--max-time',
      '15',
      'https://api.ipify.org',
    ],
    { encoding: 'utf8', env, maxBuffer: 1024, timeout: 20_000 },
  );
  return stdout.trim();
}

export async function verifyOpencodeProxy(
  env: NodeJS.ProcessEnv,
  sameRepo: boolean,
  log: ProxyLogger,
  check: EgressCheck = checkProxyEgress,
): Promise<NodeJS.ProcessEnv> {
  if (!env.HTTPS_PROXY) {
    log.info('OpenCode proxy is not configured; continuing without it');
    return {};
  }
  if (!sameRepo) {
    log.info('OpenCode proxy is disabled for fork-head PRs');
    return {};
  }

  try {
    const ip = await check(env);
    if (!isIP(ip)) throw new Error('invalid egress response');
    log.info(`OpenCode proxy verified; egress: ${ip}`);
    return env;
  } catch {
    log.warning('OpenCode proxy verification failed; continuing without it');
    return {};
  }
}
