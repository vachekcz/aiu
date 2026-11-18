import { get } from 'node:http';

/** Simulates a browser hitting a local URL; resolves with the status code. */
export function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}
