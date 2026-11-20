import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLES, EXAMPLES_DIR, renderExample } from '../scripts/readme-examples.ts';

describe('README examples', () => {
  it.each(EXAMPLES.map((example) => [example.file, example] as const))('docs/examples/%s matches the current output (run npm run docs:examples)', (file, example) => {
    expect(renderExample(example)).toBe(readFileSync(join(EXAMPLES_DIR, file), 'utf8'));
  });
});
