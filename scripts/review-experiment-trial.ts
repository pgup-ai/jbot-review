import { readFileSync } from 'node:fs';
import type { ReviewExperiment } from '../src/shared/review-experiment.ts';

const [configPath, stage, ...args] = process.argv.slice(2);
if (!configPath || (stage !== 'review' && stage !== 'verification'))
  throw new Error('Expected experiment config, review/verification, and trial arguments');
const experiment: ReviewExperiment = JSON.parse(readFileSync(configPath, 'utf8'));
if (stage === 'verification') {
  const { runVerificationTrial } = await import('./jev-verification-trial.ts');
  await runVerificationTrial(experiment, args);
} else {
  const { runLocalReview } = await import('../src/local/index.ts');
  process.argv = [...process.argv.slice(0, 2), ...args];
  await runLocalReview(experiment);
}
