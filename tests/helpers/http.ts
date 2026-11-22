import { get } from 'node:http';

/** Simulates a browser hitting a local URL; resolves with the status code. */
export function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error(`No response from ${url}`)));
  });
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
