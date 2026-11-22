import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes pretty-printed JSON so that a reader never sees a half-written file: a temporary file next
 * to the target, then a rename. The directory is created private (0700), the file is 0600.
 */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryFile, file);
}
