import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJob } from '../src/worker/run-job.ts';

test('slim workers reject unsupported main or auxiliary models before contacting GitHub', async () => {
  const previous = process.env.JBOT_IMAGE_VARIANT;
  process.env.JBOT_IMAGE_VARIANT = 'slim';
  try {
    for (const [model, auxModel] of [
      ['cline/test', null],
      ['opencode/test', 'cline/test'],
    ] as const) {
      const logs: string[] = [];
      const result = await runJob(
        {
          jobId: '1',
          repoFullName: 'o/r',
          prNumber: 1,
          model,
          auxModel,
          apiKey: 'unused',
          auxApiKey: null,
          installationToken: 'unused',
          claimToken: 'fence',
        },
        (message) => logs.push(message),
      );
      assert.equal(result.status, 'failed');
      assert.equal(result.claimToken, 'fence');
      assert.match(logs.join('\n'), /slim image does not include these local runtimes: cline/);
    }
  } finally {
    if (previous === undefined) delete process.env.JBOT_IMAGE_VARIANT;
    else process.env.JBOT_IMAGE_VARIANT = previous;
  }
});
