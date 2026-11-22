import { createHash } from 'node:crypto';

export function observesGuidelineVerifier(
  mainModel: string,
  auxModel: string,
  mainEngine: string,
  auxEngine: string,
  cap: number,
): boolean {
  return (
    cap === 10 &&
    mainModel === 'opencode-go/deepseek-v4.1-flash' &&
    auxModel === mainModel &&
    mainEngine === 'opencode' &&
    auxEngine === 'opencode'
  );
}

export function guidelinePreviewPolicy(input: {
  mainFinished: boolean;
  partial: boolean;
  sharedSource: boolean;
  verificationRetrieval: boolean;
  verificationProof: boolean;
  fork: boolean;
}) {
  if (input.mainFinished || input.partial) return 'skip';
  // Previewing must not warm the live evidence cache or create a verifier session.
  return input.sharedSource || input.verificationRetrieval || input.verificationProof || input.fork
    ? 'unavailable'
    : 'prepare';
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Parallel shards can reach OpenCode in either order. Each digest still covers
// one entire ordered prompt, and repeated batches retain their multiplicity.
function batchHash(hashes: string[]): string | null {
  return hashes.length ? digest(JSON.stringify([...hashes].sort())) : null;
}

export class GuidelineVerifierShadow {
  private readonly early: string[] = [];
  private readonly actual: string[] = [];
  private settledAt?: number;
  private readyAt?: number;
  private slots?: number;
  private state = 'no-early-batch';

  begin(now: number, freeSlots: number) {
    this.settledAt = now;
    this.slots = freeSlots;
    this.state = 'preparing';
  }

  earlyPrompt(prompt: string) {
    this.early.push(digest(prompt));
  }

  actualPrompt(prompt: string) {
    this.actual.push(digest(prompt));
  }

  prepared(now: number, complete: boolean) {
    this.readyAt = complete ? now : undefined;
    this.state = complete ? 'prepared' : 'unavailable';
  }

  report(mainDoneAt: number, verificationFailed: boolean) {
    const complete = this.state === 'prepared';
    const earlyHash = complete ? batchHash(this.early) : null;
    const actualHash = batchHash(this.actual);
    return {
      state: this.state === 'preparing' ? 'unavailable' : this.state,
      freeSlots: this.slots ?? null,
      overlapMs: this.settledAt === undefined ? 0 : Math.max(0, mainDoneAt - this.settledAt),
      preparedOverlapMs: this.readyAt === undefined ? 0 : Math.max(0, mainDoneAt - this.readyAt),
      earlyBatches:
        this.state === 'preparing' || this.state === 'unavailable' ? null : this.early.length,
      actualBatches: this.actual.length,
      earlyHash,
      actualHash,
      match:
        this.state === 'prepared' && earlyHash && !verificationFailed
          ? earlyHash === actualHash
          : null,
    };
  }
}
