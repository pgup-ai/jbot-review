import { readJevResponse, requestJev } from './jev-client.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { JEV_MODEL, jevVerifierQuestions } from './prompt.ts';
import type { Finding } from './types.ts';

interface Pass {
  model: string;
  prompt?: string | null;
  elapsedMs: number;
}

const activePass = new AsyncLocalStorage<Pass>();

// Capture the backend's final packet, including native evidence and tool directives.
// Budget probes, recovery prompts and concurrent batches must never supply this text.
export function observeVerifierPacket(label: string, model: string, prompt: string | null): void {
  if (label !== 'finding-verification') return;
  const pass = activePass.getStore();
  if (pass) Object.assign(pass, { model, prompt });
}

export class JevVerifierShadow {
  private readonly lifetime = new AbortController();

  constructor(
    private readonly key: string,
    private readonly log: (message: string) => void,
  ) {}

  async time<T>(pass: Pass, call: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await activePass.run(pass, call);
    } finally {
      pass.elapsedMs = Math.round(performance.now() - start);
    }
  }

  stop() {
    this.lifetime.abort();
  }

  async record(targets: Finding[], first: Pass, second: Pass, rechecked?: Finding[]) {
    const batchId = randomUUID();
    const start = performance.now();
    let status = first.prompt === null ? 'inherited-context' : 'unobserved';
    let scores: number[] = [];
    if (first.prompt) {
      try {
        const body = JSON.stringify({
          model: JEV_MODEL,
          state: { packet: first.prompt },
          questions: jevVerifierQuestions(targets.length),
        });
        if (Buffer.byteLength(body) > 512 * 1024) status = 'oversize';
        else {
          const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000)]);
          const response = await requestJev(body, this.key, signal);
          if (!response.ok) {
            status = `http-${response.status}`;
            if (response.status === 400) {
              const detail = (await readJevResponse(response).catch(() => null))?.detail;
              if (detail?.error_type === 'max_tokens_exceeded') status = 'oversize';
            } else await response.body?.cancel();
          } else {
            const value = await readJevResponse(response);
            scores = targets.map((_, i) => {
              const answer = value.answers?.[`f${i}`];
              if (
                value.model !== JEV_MODEL ||
                answer?.type !== 'noul' ||
                typeof answer.noul !== 'number' ||
                !Number.isFinite(answer.noul) ||
                answer.noul < 0 ||
                answer.noul > 1
              )
                throw new Error('Invalid Jev score');
              return answer.noul;
            });
            status = 'scored';
          }
        }
      } catch {
        status = this.lifetime.signal.aborted ? 'cancelled' : 'unavailable';
      }
    }
    const jevMs = Math.round(performance.now() - start);
    for (const [index, finding] of targets.entries()) {
      const score = scores[index] ?? null;
      const selected = rechecked?.includes(finding);
      const neededSecondPass = selected && second.prompt === undefined ? null : (selected ?? null);
      this.log(
        'Jev verifier shadow: ' +
          JSON.stringify({
            batchId,
            index,
            path: finding.path,
            line: finding.line,
            model: first.model,
            jevModel: JEV_MODEL,
            threshold: 0.5,
            status,
            score,
            sufficient: score === null ? null : score >= 0.5,
            neededSecondPass,
            firstPassMs: first.elapsedMs,
            secondPassMs: neededSecondPass ? second.elapsedMs : null,
            secondPassModel: neededSecondPass ? second.model : null,
            jevMs,
          }),
      );
    }
  }
}
