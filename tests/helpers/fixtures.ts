import { readFileSync } from 'node:fs';

/** A recorded provider response from tests/fixtures/, by file name without the extension. */
export const loadFixture = (name: string): any => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
