import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../../src/store/jsonFile.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiu-json-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('writeJsonFile', () => {
  it('writes pretty-printed JSON with a trailing newline', async () => {
    const file = join(dir, 'data.json');
    await writeJsonFile(file, [{ provider: 'claude', label: 'work' }]);
    expect(await readFile(file, 'utf8')).toBe('[\n  {\n    "provider": "claude",\n    "label": "work"\n  }\n]\n');
  });

  it('creates missing directories private and the file readable by the owner only', async () => {
    const file = join(dir, 'nested', 'deeper', 'data.json');
    await writeJsonFile(file, {});
    expect(await mode(file)).toBe(0o600);
    expect(await mode(join(dir, 'nested', 'deeper'))).toBe(0o700);
    expect(await mode(join(dir, 'nested'))).toBe(0o700);
  });

  it('replaces an existing file and leaves no temporary file behind', async () => {
    const file = join(dir, 'data.json');
    await writeFile(file, 'old');
    await writeJsonFile(file, { fresh: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ fresh: true });
    expect(await readdir(dir)).toEqual(['data.json']);
  });

  it('rejects when the target directory cannot be created', async () => {
    await writeFile(join(dir, 'blocker'), '');
    await expect(writeJsonFile(join(dir, 'blocker', 'data.json'), {})).rejects.toThrow();
  });
});
