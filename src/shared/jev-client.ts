export function requestJev(body: string, key: string, signal: AbortSignal) {
  return fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
  });
}

export async function readJevResponse(response: Response) {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > 16_384) throw new Error('invalid-response');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid-response');
  }
}
