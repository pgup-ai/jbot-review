type Job = () => Promise<void>;

let pending = 0;
const CONCURRENCY = 2;
const queue: Job[] = [];

function pump(): void {
  while (pending < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    pending += 1;
    job().finally(() => {
      pending -= 1;
      pump();
    });
  }
}

export function enqueue(job: Job): void {
  queue.push(job);
  pump();
}
